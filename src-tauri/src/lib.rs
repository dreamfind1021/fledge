mod sidecar;

use tauri::Manager;
use sidecar::{
    generate_token, reap_orphan_sidecar, restart_sidecar, sidecar_port, sidecar_token,
    spawn_sidecar, SidecarState,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(SidecarState::default())
        .setup(|app| {
            reap_orphan_sidecar(); // 清上次 crash 殘留再起新的
            // 生 per-launch token、存入 state（spawn 會讀它設 env）
            *app.state::<SidecarState>().token.lock().unwrap() = Some(generate_token());
            spawn_sidecar(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![sidecar_port, restart_sidecar, sidecar_token])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // app 退出：收掉當前 sidecar 子進程 + 清 pidfile（dev/prod 同一路徑）
            if let tauri::RunEvent::Exit = event {
                sidecar::kill_sidecar(app_handle);
            }
        });
}
