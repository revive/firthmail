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

            app.manage(bridge::Engine::new(core.clone()));
            bridge::forward_events(core, handle);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bridge::list_accounts,
            bridge::add_account,
            bridge::remove_account,
            bridge::oauth_client_id,
            bridge::set_oauth_client_id,
            bridge::start_microsoft_login,
            bridge::cancel_oauth,
            bridge::list_folders,
            bridge::account_folder_roles,
            bridge::list_messages,
            bridge::get_body,
            bridge::perform_action,
            bridge::empty_trash,
            bridge::sync_now,
            bridge::scan_import,
            bridge::import_local_mail,
            bridge::cancel_import,
            bridge::save_draft,
            bridge::queue_send,
            bridge::search_messages,
            bridge::diag,
        ])
        .run(tauri::generate_context!())
        .expect("error while running FirthMail");
}
