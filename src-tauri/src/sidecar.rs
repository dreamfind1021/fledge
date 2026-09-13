use std::sync::Mutex;

use tauri::{AppHandle, Manager, State};

// dev/prod 統一用 std::process::Command 起 sidecar，故 child handle 型別一致
type ChildHandle = std::process::Child;

#[derive(Default)]
pub struct SidecarState {
    pub port: Mutex<Option<u16>>,
    /// 當前 sidecar 子進程 handle（dev/prod 統一持有）；restart/exit 時 kill。
    pub child: Mutex<Option<ChildHandle>>,
    /// 重啟互斥，防併發 restart 交錯。
    pub restart_in_progress: Mutex<bool>,
    /// per app-launch 認證 token；初次與 restart 都用同一個。
    pub token: Mutex<Option<String>>,
    /// 最近一次 spawn 失敗的原因（binary 遺失、無執行權限…）。
    /// 存起來給前端查：spawn 失敗時 port 永遠不會來，沒有這個前端只能空等到逾時，
    /// 還把精確原因換成通用訊息。restart 前會清掉。
    pub spawn_error: Mutex<Option<String>>,
}

/// 生成 per-launch 認證 token（uuid v4、CSPRNG）。
pub fn generate_token() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// pidfile 所在目錄（`~/.fledge`）；reaper 掃這裡找所有實例留下的 pidfile。
fn fledge_dir() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    std::path::Path::new(&home).join(".fledge")
}

/// 本 app 實例的 pidfile：`~/.fledge/sidecar.<app pid>.pid`。
/// 檔名帶 app 自己的 pid 是票 20 的關鍵——dev 與打包版（或兩個打包版）曾共用一個 `sidecar.pid`，
/// 後起的實例會把先起的 pid 記錄蓋掉，reaper 也因此殺到別人正在用的 sidecar。
fn pidfile_path() -> std::path::PathBuf {
    fledge_dir().join(format!("sidecar.{}.pid", std::process::id()))
}

/// 檔名是否為 sidecar pidfile。收新格式 `sidecar.<pid>.pid` 與舊格式 `sidecar.pid`（換版前的
/// 打包版還在寫它，reaper 要能一併處理）；排除原子寫入的 `.tmp` 與任何非 `.pid` 結尾的檔。
fn is_pidfile_name(name: &str) -> bool {
    name.starts_with("sidecar.") && name.ends_with(".pid")
}

/// 原子寫 pidfile：temp + rename（避免 crash 留半個 PID／空檔）。
fn write_pidfile(pid: u32) {
    let path = pidfile_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = path.with_extension("pid.tmp");
    if std::fs::write(&tmp, pid.to_string()).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

/// 一次 ps 查到的進程事實。三態分開是因為 reaper 對「不確定」與「確認不在」要做不同的事：
/// 原本把兩種都壓成空字串，會把「查不到」當「不在」而刪掉別的實例的 pidfile（Codex R2／R3）。
#[derive(Debug, PartialEq)]
enum Probe {
    /// ps 起不來、被訊號中止、或輸出解析不出來 → 什麼都不確定
    Unknown,
    /// ps 明確回「沒有這個 pid」
    Absent,
    Present { ppid: u32, cmdline: String },
}

/// 一次 `ps -p <pid> -o ppid=,command=` 同時拿父進程與 cmdline（合併是為了少一次 fork，也消掉
/// 兩次查詢之間進程狀態變動的縫）。
fn probe_pid(pid: u32) -> Probe {
    match std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "ppid=,command="])
        .output()
    {
        Ok(out) => parse_ps_probe(out.status.code(), &String::from_utf8_lossy(&out.stdout)),
        Err(_) => Probe::Unknown,
    }
}

/// ps 結果 → Probe（純函式，方便把分類釘在測試裡）。exit 1＝pid 不存在（ps 對不存在的 pid 就回 1）；
/// code None＝被訊號中止，不能當不存在。
fn parse_ps_probe(code: Option<i32>, stdout: &str) -> Probe {
    match code {
        Some(0) => {
            let line = stdout.trim();
            match line.split_once(char::is_whitespace) {
                Some((ppid, cmd)) => match ppid.parse() {
                    Ok(ppid) => Probe::Present { ppid, cmdline: cmd.trim().to_string() },
                    Err(_) => Probe::Unknown,
                },
                None => Probe::Unknown,
            }
        }
        Some(_) => Probe::Absent,
        None => Probe::Unknown,
    }
}

/// reaper 對一個 pidfile 該做的事。
#[derive(Debug, PartialEq)]
enum ReapAction {
    /// 確認是真 orphan → 先禮後兵殺掉、成功後刪檔
    Terminate,
    /// 進程已不在或 pid 被別的程式重用 → 只刪檔、不碰進程
    RemoveFile,
    /// 別的實例正在用、或任何一項查不到 → 什麼都不動，pidfile 留到下次啟動再看
    Keep,
}

/// reaper 決策表（純函式，方便把每一格釘死在測試裡）。
/// 原則：**只有明確查到才動手**，Unknown 一律 Keep——查不到不能當不在（會刪掉別的實例的
/// pidfile，Codex R2），也不能當 orphan（父可能還活著，Codex R1）。
/// ppid == 1：macOS 上父進程死掉的子進程一律由 launchd 收養，這才是真 orphan；
/// 其他值＝父活著＝別的 Fledge 實例正在用（票 20）。依賴 macOS 沒有 subreaper。
fn reap_action(probe: &Probe) -> ReapAction {
    match probe {
        Probe::Unknown => ReapAction::Keep,
        Probe::Absent => ReapAction::RemoveFile,
        Probe::Present { cmdline, .. } if !cmdline_is_sidecar(cmdline) => ReapAction::RemoveFile,
        Probe::Present { ppid: 1, .. } => ReapAction::Terminate,
        Probe::Present { .. } => ReapAction::Keep,
    }
}

/// cmdline 是否為我們的 sidecar（含標記）。不含標記＝pid 被別的程式重用 → 非 sidecar（寧漏殺不誤殺）。
fn cmdline_is_sidecar(cmdline: &str) -> bool {
    !cmdline.is_empty() && (cmdline.contains("fledge_sidecar") || cmdline.contains("fledge-sidecar"))
}

/// 供 reap_orphan_sidecar 用（pid-only、無 Child handle）：對 pid 先禮後兵。
/// 每次動作前重讀 cmdline 確認「仍是 sidecar」才動——避免 pid 在 grace 窗口被重用而誤殺。
/// grace 3s > sidecar uvicorn timeout_graceful_shutdown 2s + buffer（時序不變量）。
/// 註：有 Child handle 的 kill_current_child 不走這裡（用 try_wait 收 zombie，見該函式）。
/// 回傳是否「確認該 pid 已消失」——reaper 只在 true 才移除 pidfile（Codex PR-gate / spec §1.3）。
fn terminate_pid_gracefully(pid: u32) -> bool {
    let pid_s = pid.to_string();
    // Some(true)＝仍是 sidecar；Some(false)＝已不在或 pid 換人；None＝ps 查不到。
    // None 一律不動手也不宣稱已收——「查不到」不等於「已退出」（Codex R2）。
    let probe = || match probe_pid(pid) {
        Probe::Present { cmdline, .. } => Some(cmdline_is_sidecar(&cmdline)),
        Probe::Absent => Some(false),
        Probe::Unknown => None,
    };
    match probe() {
        Some(false) => return true, // 已不在或非 sidecar → 視為已收
        None => return false,
        Some(true) => {}
    }
    let _ = std::process::Command::new("kill").args(["-TERM", &pid_s]).status();
    let mut waited = 0u32;
    while waited < 3000 {
        if probe() == Some(false) {
            return true; // 已退出（或 pid 換人）
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
        waited += 100;
    }
    // 逾時：只有「確認仍是 sidecar」才 SIGKILL——pid 重用防護就靠這次確認，查不到就不動
    if probe() != Some(true) {
        return false;
    }
    let _ = std::process::Command::new("kill").args(["-KILL", &pid_s]).status();
    let mut w = 0u32;
    while w < 500 && probe() == Some(true) {
        std::thread::sleep(std::time::Duration::from_millis(50));
        w += 50;
    }
    probe() == Some(false) // 回傳是否確認消失
}

/// kill 當前 child（先禮後兵）+ 移除 pidfile。
/// 用 try_wait poll（會收 zombie 並即時偵測退出）——不可用 ps poll（zombie 會讓每次 restart 白等 3s）。
fn kill_current_child(state: &SidecarState) {
    if let Some(mut child) = state.child.lock().unwrap().take() {
        // 先禮：SIGTERM 讓 sidecar 跑 close_all 關掉 PTY 子進程
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &child.id().to_string()])
            .status();
        let mut waited = 0u32;
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,                       // 已退出（try_wait 同時收回 zombie）
                Err(_) => { let _ = child.kill(); break; }  // 查不到狀態 → SIGKILL 保底，別空等到 3s
                Ok(None) => {}                              // 還在跑
            }
            if waited >= 3000 {
                let _ = child.kill(); // 後兵：SIGKILL（grace 3s > sidecar graceful 2s）
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
            waited += 50;
        }
        let _ = child.wait(); // 確保收回
    }
    let _ = std::fs::remove_file(pidfile_path());
}

/// 解析 sidecar 輸出的一行：抓 `FLEDGE_PORT=<port>` 寫入 state，其餘轉發 stderr（前綴 [sidecar]）。
fn handle_sidecar_line(app_handle: &AppHandle, raw: &str) {
    let line = raw.trim();
    if line.is_empty() {
        return;
    }
    if let Some(port_str) = line.strip_prefix("FLEDGE_PORT=") {
        if let Ok(port) = port_str.parse::<u16>() {
            *app_handle.state::<SidecarState>().port.lock().unwrap() = Some(port);
            eprintln!("[fledge] sidecar listening on port {}", port);
        }
    } else {
        eprintln!("[sidecar] {}", line);
    }
}

/// 從 shell 輸出抓 sentinel 行（`<prefix>` 開頭）的 PATH。容忍 interactive shell 啟動的 stdout 噪音；
/// 取**最後一個**匹配行（我們的 printf 是最後一個命令、輸出在最後），prefix 帶 nonce 避免 .zshrc 撞名。
/// cfg：prod 會用到；test 也要編進來測。debug 非測試 build 不編（避免 dead_code 警告）。
#[cfg(any(not(debug_assertions), test))]
fn parse_sentinel_path(stdout: &str, prefix: &str) -> Option<String> {
    stdout
        .lines()
        .rev()
        .find_map(|l| l.strip_prefix(prefix))
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty())
}

/// prod：GUI 從 Finder 啟動的 .app 只有最小 PATH，找不到 ~/.local/bin 等處的 claude。
/// 用 login+interactive shell（讀 .zprofile+.zshrc）解析真實 PATH 注入 sidecar——
/// sidecar 的 which("claude") 與它生的 PTY(claude) 都會繼承。失敗/逾時回 None → 不覆寫 PATH（不比現況糟）。
/// 硬化（Codex）：① 跑在 thread + 2s recv_timeout，防 .zshrc 卡 tty 而 hang app 啟動；
/// ② printf 引號包 $PATH 防 word-splitting/globbing；③ sentinel 帶 uuid nonce 防 .zshrc 撞名；
/// ④ stdin null 防 interactive shell 等輸入。
#[cfg(not(debug_assertions))]
fn login_shell_path() -> Option<String> {
    use std::process::Stdio;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let nonce = uuid::Uuid::new_v4().simple().to_string();
        let prefix = format!("FLEDGE_PATH_{nonce}=");
        let cmd = format!("printf '%s\\n' \"{prefix}$PATH\"");
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        let result = std::process::Command::new(&shell)
            .args(["-lic", &cmd])
            .stdin(Stdio::null())
            .output()
            .ok()
            .filter(|o| o.status.success())
            .and_then(|o| parse_sentinel_path(&String::from_utf8_lossy(&o.stdout), &prefix));
        let _ = tx.send(result);
    });
    // 逾時（.zshrc hang）→ recv_timeout Err → None；放棄該 thread/子進程（罕見、不阻塞 app）
    rx.recv_timeout(std::time::Duration::from_secs(2)).ok().flatten()
}

/// 啟動 Python sidecar（dev/prod 統一用 std::process::Command，只差 program/args）：
/// - dev（debug）：venv python -m fledge_sidecar（跳過解壓開銷）
/// - prod（release）：bundle 內 onedir sidecar exe（resource_dir）
///
/// 回 `Result` 而非 panic：`.claude/tauri-rust.md` §4 允許 startup 用 `expect` fail-fast，但那適用於
/// 「壞掉就無從補救」的前置條件。sidecar spawn 失敗（binary 遺失、無執行權限、被系統阻擋）是
/// **使用者可修復且值得被告知**的狀態——panic 會讓 webview 根本起不來，啟動畫面的錯誤態與重試
/// 按鈕就永遠到不了，而那正是它們存在的理由。
pub fn spawn_sidecar(app: &AppHandle) -> Result<(), String> {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};

    let app_handle = app.clone();
    let token = app
        .state::<SidecarState>()
        .token
        .lock()
        .unwrap()
        .clone()
        // 錯誤字串一律英文：它們會出現在啟動畫面的「詳細資訊」供使用者截圖回報，
        // 跨語言回報時英文比較有用（註解仍中文，見 CLAUDE.md）。
        .ok_or_else(|| "FLEDGE_TOKEN must be set by setup before spawn".to_string())?;

    #[cfg(debug_assertions)]
    let (program, args): (std::path::PathBuf, Vec<&str>) = (
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or_else(|| "src-tauri should have a parent project root".to_string())?
            .join("sidecar/.venv/bin/python"),
        vec!["-m", "fledge_sidecar"],
    );
    #[cfg(not(debug_assertions))]
    let (program, args): (std::path::PathBuf, Vec<&str>) = (
        app.path()
            .resource_dir()
            .map_err(|e| format!("resource_dir unavailable: {e}"))?
            .join("fledge-sidecar")
            .join("fledge-sidecar"),
        vec![],
    );

    let mut cmd = Command::new(&program);
    cmd.args(&args)
        .env("FLEDGE_TOKEN", token)
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    // prod：注入 login-shell PATH，讓 sidecar/PTY 找得到 ~/.local/bin 等處的 claude（dev 已繼承終端機 PATH）
    #[cfg(not(debug_assertions))]
    if let Some(path) = login_shell_path() {
        cmd.env("PATH", path);
    }
    // 錯誤訊息帶完整路徑：使用者展開 Splash 的「詳細資訊」時，要一眼看出是哪個 binary 出問題
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("spawn {} failed: {e}", program.display()))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "sidecar stdout unavailable".to_string())?;
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            handle_sidecar_line(&app_handle, &line);
        }
    });
    let pid = child.id();
    *app.state::<SidecarState>().child.lock().unwrap() = Some(child);
    write_pidfile(pid);
    Ok(())
}

/// 前端查最近一次 spawn 失敗的原因；沒有失敗回 None。
#[tauri::command]
pub fn sidecar_spawn_error(state: State<SidecarState>) -> Option<String> {
    state.spawn_error.lock().unwrap().clone()
}

/// app 退出時呼叫：kill 當前 sidecar 子進程 + 移除本實例的 pidfile（別的實例的不碰）。
pub fn kill_sidecar(app: &AppHandle) {
    kill_current_child(&app.state::<SidecarState>());
}

/// 前端查詢 sidecar port。未就緒時回 None。
#[tauri::command]
pub fn sidecar_port(state: State<SidecarState>) -> Option<u16> {
    *state.port.lock().unwrap()
}

/// 前端查詢 per-launch 認證 token。未就緒回 None。
#[tauri::command]
pub fn sidecar_token(state: State<SidecarState>) -> Option<String> {
    state.token.lock().unwrap().clone()
}

/// 啟動時清掉上次 crash 殘留的 sidecar（安全預設：無法確認 cmdline 就不 kill）。
/// pidfile 一個實例一個檔（見 pidfile_path），上次的 app pid 跟這次不同，所以要掃整個目錄。
pub fn reap_orphan_sidecar() {
    reap_orphans_in(&fledge_dir());
}

/// 掃 dir 底下所有 pidfile 逐一處理。拆出 dir 參數是讓測試能用暫存目錄跑真進程。
fn reap_orphans_in(dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return; // 目錄不存在：乾淨
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_pidfile = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(is_pidfile_name)
            .unwrap_or(false);
        if is_pidfile {
            reap_pidfile(&path);
        }
    }
}

/// 處理單一 pidfile：真 orphan 才殺；別的實例正在用的不碰。
fn reap_pidfile(pidfile: &std::path::Path) {
    let Ok(content) = std::fs::read_to_string(pidfile) else {
        return;
    };
    let Ok(pid) = content.trim().parse::<u32>() else {
        let _ = std::fs::remove_file(pidfile); // parse 失敗 → 只清檔、不 kill
        return;
    };
    let probe = probe_pid(pid);
    match reap_action(&probe) {
        ReapAction::Keep => {
            eprintln!(
                "[fledge] pidfile pid {} {:?} → 別的實例在用或查不到，不動、保留 pidfile",
                pid, probe
            );
            return;
        }
        ReapAction::RemoveFile => {
            eprintln!(
                "[fledge] pidfile pid {} 無法確認為 sidecar（{:?}）→ 不 kill、清檔",
                pid, probe
            );
            let _ = std::fs::remove_file(pidfile);
            return;
        }
        ReapAction::Terminate => {}
    }
    if terminate_pid_gracefully(pid) {
        // 確認舊 sidecar 已退出 → 才清 pidfile（spec §1.3 / Codex PR-gate）
        eprintln!("[fledge] reaped orphan sidecar pid {}", pid);
        let _ = std::fs::remove_file(pidfile);
    } else {
        // 無法確認退出 → 保留 pidfile（下次啟動再 reap）、loud log，不靜默
        eprintln!(
            "[fledge] 警告：orphan sidecar pid {} 無法確認已退出 → 保留 pidfile",
            pid
        );
    }
}

#[cfg(test)]
mod tests {
    use super::generate_token;

    /// 票 20：pidfile 一個 app 實例一個檔，dev／打包版／兩個打包版並存都不會互相覆寫。
    #[test]
    fn pidfile_path_is_per_app_instance() {
        let p = super::pidfile_path();
        let expected = format!("sidecar.{}.pid", std::process::id());
        assert_eq!(p.file_name().and_then(|n| n.to_str()), Some(expected.as_str()));
        assert_eq!(
            p.parent().and_then(|d| d.file_name()).and_then(|n| n.to_str()),
            Some(".fledge")
        );
    }

    /// 掃目錄時只收 pidfile：新格式、舊格式（打包版換版前留下的）都要；原子寫入的 `.tmp`
    /// 與使用者手動移開的 `.hold` 不能被當殘留處理。
    #[test]
    fn is_pidfile_name_accepts_new_and_legacy_rejects_tmp_and_hold() {
        assert!(super::is_pidfile_name("sidecar.2087.pid"));
        assert!(super::is_pidfile_name("sidecar.pid"));
        assert!(!super::is_pidfile_name("sidecar.2087.pid.tmp"));
        assert!(!super::is_pidfile_name("sidecar.pid.hold"));
        assert!(!super::is_pidfile_name("other.pid"));
        assert!(!super::is_pidfile_name("config.toml"));
    }

    /// 測試用暫存目錄，Drop 時一定刪掉（斷言失敗 panic 也會清）。
    struct TempDir(std::path::PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let d = std::env::temp_dir()
                .join(format!("fledge-reaper-test-{}-{}", std::process::id(), tag));
            std::fs::create_dir_all(&d).unwrap();
            Self(d)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// 測試用假 sidecar（本進程直接 spawn 的子進程），Drop 時一定收掉。
    struct FakeSidecar(std::process::Child);
    impl Drop for FakeSidecar {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    /// 票 20 本尊：另一個 Fledge 實例正在用的 sidecar（父進程活著）不是 orphan，
    /// reaper 不能殺它、也不能動它的 pidfile。
    #[test]
    fn reaper_skips_sidecar_whose_parent_is_alive() {
        let dir = TempDir::new("alive");
        // 假 sidecar：cmdline 帶標記、父進程＝本測試進程。要兩個指令 sh 才會留著——
        // 單一指令 sh 會直接 exec 成 sleep，cmdline 就沒有標記了。
        let child = std::process::Command::new("sh")
            .args(["-c", "sleep 5; true", "fledge_sidecar_fake"])
            .spawn()
            .unwrap();
        let pidfile = dir.0.join("sidecar.99999.pid");
        std::fs::write(&pidfile, child.id().to_string()).unwrap();
        let mut fake = FakeSidecar(child);
        std::thread::sleep(std::time::Duration::from_millis(100));

        super::reap_orphans_in(&dir.0);

        assert!(pidfile.exists(), "父進程活著的 sidecar 不是 orphan，pidfile 不該被動");
        assert!(
            matches!(fake.0.try_wait(), Ok(None)),
            "父進程活著的 sidecar 不該被殺"
        );
    }

    /// 守住原功能：真 orphan（父進程已死、被 launchd 收養）仍要被殺並清 pidfile。
    #[test]
    fn reaper_kills_true_orphan_and_removes_pidfile() {
        let dir = TempDir::new("orphan");
        // 造 orphan：外層 sh 起內層假 sidecar 後立刻退出，內層被 launchd 收養（ppid=1）。
        // 內層 stdout/stderr 導到 /dev/null，否則 output() 會等內層結束才回。
        let out = std::process::Command::new("sh")
            .args([
                "-c",
                r#"sh -c "sleep 5; true" fledge_sidecar_fake >/dev/null 2>&1 & echo $!"#,
            ])
            .output()
            .unwrap();
        let pid: u32 = String::from_utf8_lossy(&out.stdout).trim().parse().unwrap();
        let pidfile = dir.0.join("sidecar.99998.pid");
        std::fs::write(&pidfile, pid.to_string()).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(100));
        assert!(
            matches!(super::probe_pid(pid), super::Probe::Present { ppid: 1, .. }),
            "前置：內層應已被 launchd 收養"
        );

        super::reap_orphans_in(&dir.0);

        let still_there = matches!(super::probe_pid(pid), super::Probe::Present { .. });
        // 保底：萬一沒殺掉別讓它留 20 秒
        let _ = std::process::Command::new("kill").args(["-KILL", &pid.to_string()]).status();
        assert!(!still_there, "orphan 應已被殺");
        assert!(!pidfile.exists(), "orphan 收掉後 pidfile 要清");
    }

    /// ps 結果 → 進程事實的分類（Codex R3：觀測層要先把「查不到」和「不在」分開，決策表才不會
    /// 收到錯誤的確定值）。exit 1＝pid 不存在；被訊號中止（code None）＝什麼都不確定。
    #[test]
    fn parse_ps_probe_classifies_unknown_absent_present() {
        use super::Probe;
        assert_eq!(super::parse_ps_probe(None, ""), Probe::Unknown, "ps 被訊號中止");
        assert_eq!(super::parse_ps_probe(Some(1), ""), Probe::Absent, "pid 不存在");
        assert_eq!(
            super::parse_ps_probe(Some(0), "  2069 /Applications/Fledge.app/x/fledge-sidecar\n"),
            Probe::Present { ppid: 2069, cmdline: "/Applications/Fledge.app/x/fledge-sidecar".into() }
        );
        // cmdline 內含空白只切第一段（ppid），其餘原樣
        assert_eq!(
            super::parse_ps_probe(Some(0), "1 sh -c sleep 5; true fledge_sidecar_fake\n"),
            Probe::Present { ppid: 1, cmdline: "sh -c sleep 5; true fledge_sidecar_fake".into() }
        );
        assert_eq!(super::parse_ps_probe(Some(0), "garbage"), Probe::Unknown, "解析不出 ppid：不確定");
    }

    /// reaper 決策表：每一種進程事實都釘死。
    /// Codex R1 high：父進程活著不是 orphan；R2 medium：查不到不能當不在（會刪別的實例的 pidfile）。
    #[test]
    fn reap_action_decision_table() {
        use super::{Probe, ReapAction::*};
        let sc = |ppid| Probe::Present { ppid, cmdline: "python -m fledge_sidecar".into() };
        assert_eq!(super::reap_action(&sc(1)), Terminate, "真 orphan：被 launchd 收養");
        assert_eq!(super::reap_action(&sc(2069)), Keep, "父活著：別的實例正在用");
        assert_eq!(super::reap_action(&Probe::Absent), RemoveFile, "進程已不在：只清檔");
        assert_eq!(
            super::reap_action(&Probe::Present { ppid: 1, cmdline: "vim".into() }),
            RemoveFile,
            "pid 被非 sidecar 重用：只清檔"
        );
        assert_eq!(super::reap_action(&Probe::Unknown), Keep, "查不到（ps 失敗）：不動");
    }

    #[test]
    fn token_non_empty_and_unique() {
        let a = generate_token();
        let b = generate_token();
        assert!(!a.is_empty());
        assert_ne!(a, b);
    }

    #[test]
    fn parse_sentinel_path_picks_line_amid_noise() {
        let out = "zsh greeting\nsome rc echo /foo\nFLEDGE_PATH_n1=/Users/x/.local/bin:/usr/bin\n";
        assert_eq!(
            super::parse_sentinel_path(out, "FLEDGE_PATH_n1="),
            Some("/Users/x/.local/bin:/usr/bin".to_string())
        );
    }

    #[test]
    fn parse_sentinel_path_none_when_absent_or_empty() {
        assert_eq!(super::parse_sentinel_path("no sentinel\n", "FLEDGE_PATH_n1="), None);
        assert_eq!(super::parse_sentinel_path("FLEDGE_PATH_n1=\n", "FLEDGE_PATH_n1="), None);
    }

    #[test]
    fn parse_sentinel_path_takes_last_match() {
        // .zshrc 若先 echo 同 prefix，取最後一個（我們的 printf 在最後一個命令、輸出在最後）
        let out = "FLEDGE_PATH_n1=/decoy\nFLEDGE_PATH_n1=/real/bin\n";
        assert_eq!(
            super::parse_sentinel_path(out, "FLEDGE_PATH_n1="),
            Some("/real/bin".to_string())
        );
    }
}

/// RAII guard：drop 時把 restart_in_progress 歸位。確保任何退出路徑（含 spawn 的 .expect
/// panic unwind）都解鎖，避免互斥永久卡 true、之後 restart 全被擋（Task2.4+2.5 review I1）。
struct RestartGuard<'a>(&'a Mutex<bool>);
impl Drop for RestartGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut g) = self.0.lock() {
            *g = false;
        }
    }
}

/// 重啟 sidecar：互斥 + kill 當前 + 清 port + 重 spawn + 等新 port。
#[tauri::command]
pub fn restart_sidecar(app: AppHandle) -> Result<u16, String> {
    let state = app.state::<SidecarState>();
    {
        let mut in_prog = state.restart_in_progress.lock().unwrap();
        if *in_prog {
            return Err("restart already in progress".into()); // 別人擁有、不碰 flag
        }
        *in_prog = true;
    }
    // 取得擁有權後才建 guard；之後任何 return / panic unwind 都會歸位 in_progress
    let _guard = RestartGuard(&state.restart_in_progress);
    kill_current_child(&state);
    *state.port.lock().unwrap() = None;
    // 清掉上一輪的失敗原因，否則前端會撿到舊錯誤、以為這次也失敗了
    *state.spawn_error.lock().unwrap() = None;
    // spawn 失敗就立刻回報，不進下面的 30s 等待——沒有子進程，port 永遠不會來
    if let Err(e) = spawn_sidecar(&app) {
        *state.spawn_error.lock().unwrap() = Some(e.clone());
        return Err(e);
    }

    let mut waited = 0u32;
    loop {
        if let Some(p) = *state.port.lock().unwrap() {
            return Ok(p);
        }
        if waited >= 30000 {
            return Err("sidecar did not report port after restart".to_string());
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
        waited += 200;
    }
}
