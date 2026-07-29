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

fn pidfile_path() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    std::path::Path::new(&home).join(".fledge").join("sidecar.pid")
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

/// 讀 pid 的 cmdline（`ps -p <pid> -o command=`）；不存在/查不到回空字串。
fn pid_cmdline(pid: u32) -> String {
    match std::process::Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "command="])
        .output()
    {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        _ => String::new(),
    }
}

/// cmdline 是否為我們的 sidecar（含標記）。空字串＝取不到 → 視為非 sidecar（寧漏殺不誤殺）。
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
    let is_sidecar = || cmdline_is_sidecar(&pid_cmdline(pid));
    if !is_sidecar() {
        return true; // 已不在或非 sidecar → 視為已收
    }
    let _ = std::process::Command::new("kill").args(["-TERM", &pid_s]).status();
    let mut waited = 0u32;
    while waited < 3000 {
        if !is_sidecar() {
            return true; // 已退出（或 pid 換人）
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
        waited += 100;
    }
    // 逾時仍在 → SIGKILL（迴圈只在「仍是 sidecar」時才走到這）
    let _ = std::process::Command::new("kill").args(["-KILL", &pid_s]).status();
    let mut w = 0u32;
    while w < 500 && is_sidecar() {
        std::thread::sleep(std::time::Duration::from_millis(50));
        w += 50;
    }
    !is_sidecar() // 回傳是否確認消失
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

/// app 退出時呼叫：kill 當前 sidecar 子進程 + 移除 pidfile（dev/prod 同一路徑）。
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
pub fn reap_orphan_sidecar() {
    let pidfile = pidfile_path();
    let Ok(content) = std::fs::read_to_string(&pidfile) else {
        return; // 無 pidfile：乾淨
    };
    let Ok(pid) = content.trim().parse::<u32>() else {
        let _ = std::fs::remove_file(&pidfile); // parse 失敗 → 只清檔、不 kill
        return;
    };
    let cmdline = pid_cmdline(pid);
    // 僅 cmdline 明確含標記才 kill；取不到/不含 → 不 kill（寧漏殺不誤殺）
    if cmdline_is_sidecar(&cmdline) {
        if terminate_pid_gracefully(pid) {
            // 確認舊 sidecar 已退出 → 才清 pidfile（spec §1.3 / Codex PR-gate）
            eprintln!("[fledge] reaped orphan sidecar pid {}", pid);
            let _ = std::fs::remove_file(&pidfile);
        } else {
            // 無法確認退出 → 保留 pidfile（下次啟動再 reap）、loud log，不靜默
            eprintln!(
                "[fledge] 警告：orphan sidecar pid {} 無法確認已退出 → 保留 pidfile",
                pid
            );
        }
    } else {
        // 取不到/非 sidecar：pidfile 已無對應 sidecar → 清掉
        eprintln!(
            "[fledge] pidfile pid {} 無法確認為 sidecar（cmdline={:?}）→ 不 kill",
            pid, cmdline
        );
        let _ = std::fs::remove_file(&pidfile);
    }
}

#[cfg(test)]
mod tests {
    use super::generate_token;

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
