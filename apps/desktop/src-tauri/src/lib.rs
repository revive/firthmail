//! FirthMail desktop shell: Tauri 2 over the flectar-mail-core engine.
//!
//! Startup: start the engine, let its account actors loose once the window
//! exists, forward engine events to the webview, and expose the command
//! surface in [`bridge`].

mod bridge;

use std::sync::Arc;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let core = tauri::async_runtime::block_on(bridge::start())?;
            let core = Arc::new(core);

            // The engine defers touching the OS keyring until the UI reports
            // ready; the window exists now, so the account workers may start.
            tauri::async_runtime::spawn({
                let core = core.clone();
                async move {
                    core.start_accounts_now().await;
                }
            });

            // 老版本导入的文件夹没有角色（Outlook 的文件夹名是中文）：
            // 启动时补齐，收件箱等视图才能合并显示导入的邮件。
            tauri::async_runtime::spawn({
                let core = core.clone();
                async move {
                    bridge::assign_import_roles(&core).await;
                }
            });

            app.manage(bridge::Engine::new(core.clone()));
            bridge::forward_events(core, handle.clone());

            // 窗口默认隐藏、由前端渲染完第一帧后显示；前端要是没起来（脚本出错、
            // WebView 异常），四秒后无论如何都显示出来，免得应用"启动但看不见"。
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(4)).await;
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.show();
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bridge::list_accounts,
            bridge::show_main_window,
            bridge::open_external,
            bridge::add_account,
            bridge::remove_account,
            bridge::oauth_client_id,
            bridge::set_oauth_client_id,
            bridge::start_microsoft_login,
            bridge::cancel_oauth,
            bridge::list_folders,
            bridge::folder_unread_counts,
            bridge::account_folder_roles,
            bridge::mark_folder_read,
            bridge::list_messages,
            bridge::list_messages_merged,
            bridge::get_body,
            bridge::perform_action,
            bridge::empty_trash,
            bridge::sync_now,
            bridge::scan_import,
            bridge::pick_folder,
            bridge::pick_outlook_file,
            bridge::import_local_mail,
            bridge::import_outlook_file,
            bridge::cancel_import,
            bridge::save_draft,
            bridge::queue_send,
            bridge::search_messages,
            bridge::diag,
        ])
        .run(tauri::generate_context!())
        .expect("error while running FirthMail");
}
