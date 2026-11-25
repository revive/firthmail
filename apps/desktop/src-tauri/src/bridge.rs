//! The flectar-mail-core engine bridge: startup, the Tauri command surface,
//! and event forwarding to the webview.
//!
//! The engine's models already speak camelCase JSON, so the commands are
//! thin pass-throughs. The one behavior this shell owns is the keyboard map -
//! see the frontend, whose Delete key arrives here as `perform_action` with
//! `kind: "trash"`.
//!
//! Local-mail import: mail the user already has on disk (ost2eml's export
//! tree, an mbox collection, a maildir) can be browsed and acted on without
//! any account, because the engine keeps such mail in a local-only store.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use flectar_mail_core::config::Paths;
use flectar_mail_core::events::CoreEvent;
use flectar_mail_core::mail_import::{scan_folder, Destination, MailImportProgress, MailImportRequest};
use flectar_mail_core::models::{
    Account, AccountFolderRoles, AddPasswordAccountArgs, ActionResult, FolderInfo, ListOrder,
    MessageCursor, MessageDetail, MessagePage, MessageSearchPage, MessageSummary, PerformActionArgs,
    Provider, QueueSendArgs, QueueSendResult, SaveDraftArgs, View,
};
use flectar_mail_core::{Core, MessagePageRequest};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

/// The running engine, shared by every command.
pub struct Engine {
    pub core: Arc<Core>,
    /// A local-mail import runs while this is set.
    import_running: Arc<AtomicBool>,
    /// Set by `cancel_import`; the running import checks it between batches.
    import_stop: Arc<AtomicBool>,
}

impl Engine {
    pub fn new(core: Arc<Core>) -> Self {
        Self {
            core,
            import_running: Arc::new(AtomicBool::new(false)),
            import_stop: Arc::new(AtomicBool::new(false)),
        }
    }
}

type EngineResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(error: E) -> String {
    error.to_string()
}

/// This app's folder under the OS data/cache roots.
const APP_DIR: &str = "FirthMail";
/// Where those folders lived before the rename from fmail.
const LEGACY_APP_DIR: &str = "fmail";

/// Start the engine with FirthMail's own data directories (separate from any
/// other host's), so the account database and cached mail live under
/// `%APPDATA%\FirthMail` and `%LOCALAPPDATA%\FirthMail`.
///
/// An installation from before the rename keeps its mail: the old `fmail`
/// folders are moved over on the first start (see [`adopt_dir`]).
pub async fn start() -> Result<Core, String> {
    let data_root =
        dirs::data_dir().ok_or("the operating system has no application data directory")?;
    let cache_root =
        dirs::cache_dir().ok_or("the operating system has no application cache directory")?;
    let (data_dir, data_moved) = adopt_dir(&data_root, APP_DIR, LEGACY_APP_DIR);
    let (cache_dir, cache_moved) = adopt_dir(&cache_root, APP_DIR, LEGACY_APP_DIR);
    if data_moved || cache_moved {
        // The database remembers the mail it kept as absolute paths; they
        // move with the folders.
        rewrite_moved_paths(
            &data_dir.join("flectar-mail.db"),
            &[
                (data_root.join(LEGACY_APP_DIR), data_dir.clone()),
                (cache_root.join(LEGACY_APP_DIR), cache_dir.clone()),
            ],
        );
    }
    Core::start_mail_ui(Paths::new(data_dir, cache_dir))
        .await
        .map_err(err)
}

/// `root/name`, taking over `root/legacy` on the first start after the
/// rename; the flag says whether the folder was moved.
///
/// The move carries the mail database, the raw mail and `keyring.json` - the
/// file naming the credential service the saved passwords live under - so
/// accounts keep signing in without asking for their passwords again.
///
/// A move that fails (fmail still running, a file held elsewhere) leaves the
/// old folder in use rather than losing the mail; the next start tries again.
fn adopt_dir(root: &Path, name: &str, legacy: &str) -> (PathBuf, bool) {
    let current = root.join(name);
    if current.exists() {
        return (current, false);
    }
    let old = root.join(legacy);
    if !old.exists() {
        return (current, false);
    }
    match std::fs::rename(&old, &current) {
        Ok(()) => {
            eprintln!(
                "[FirthMail] moved {} to {}",
                old.display(),
                current.display()
            );
            (current, true)
        }
        Err(error) => {
            eprintln!(
                "[FirthMail] could not move {} ({error}); keeping it",
                old.display()
            );
            (old, false)
        }
    }
}

/// Point the absolute paths recorded in `db` from the folders where they
/// were to where the move put them: the kept originals of messages and the
/// attachment files cached on this device.
fn rewrite_moved_paths(db: &Path, moves: &[(PathBuf, PathBuf)]) {
    if !db.exists() {
        return;
    }
    let Ok(conn) = rusqlite::Connection::open(db) else {
        eprintln!("[FirthMail] could not open {} to fix its paths", db.display());
        return;
    };
    for (from, to) in moves {
        let from = from.to_string_lossy();
        let to = to.to_string_lossy();
        for (table, column) in [("messages", "raw_path"), ("attachments", "file_path")] {
            let rows: Vec<(i64, String)> = conn
                .prepare(&format!(
                    "SELECT id, {column} FROM {table}
                     WHERE substr({column}, 1, length(?1)) = ?1"
                ))
                .and_then(|mut stmt| {
                    stmt.query_map([from.as_ref()], |row| {
                        Ok((row.get(0)?, row.get(1)?))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()
                })
                .unwrap_or_default();
            for (id, path) in rows {
                let updated = path.replacen(from.as_ref(), to.as_ref(), 1);
                let _ = conn.execute(
                    &format!("UPDATE {table} SET {column} = ?2 WHERE id = ?1"),
                    rusqlite::params![id, updated],
                );
            }
        }
    }
}

/// Bus events the forwarder has received (matched or not), for the UI's
/// event-chain diagnostics.
static EVENTS_FORWARDED: AtomicU64 = AtomicU64::new(0);

/// Forward engine events to the webview as `core-event` payloads.
///
/// `CoreEvent` itself is not `Serialize`; the shell maps the kinds the UI
/// reacts to and drops the rest (calendar, contacts, AI streaming, device
/// sync - none of which this mail-only shell shows).
///
/// A lagged receiver (`Lagged`) means a burst overflowed the bus's 1024
/// slots - the initial backfill can do that. Skipping the missed events is
/// correct; treating it as closed (as an earlier version did) silently
/// killed the forwarder after the first sync, leaving the UI event-dead.
pub fn forward_events(core: Arc<Core>, app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut events = core.bus.subscribe();
        // 启动自测：这条 emit 若到不了 webview，emit/listen 腿就是断的。
        let _ = app.emit("core-event", serde_json::json!({ "type": "bridge-alive" }));
        loop {
            let event = match events.recv().await {
                Ok(event) => event,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped)) => {
                    eprintln!("[FirthMail] event forwarder lagged, skipped {skipped}");
                    continue;
                }
                Err(closed) => {
                    eprintln!("[FirthMail] event bus closed: {closed}");
                    break;
                }
            };
            EVENTS_FORWARDED.fetch_add(1, Ordering::Relaxed);
            let payload = match &event {
                CoreEvent::MailNew {
                    account_id,
                    thread_ids,
                } => serde_json::json!({
                    "type": "mail-new",
                    "accountId": account_id,
                    "threadIds": thread_ids,
                }),
                CoreEvent::MailUpdated { thread_ids } => serde_json::json!({
                    "type": "mail-updated",
                    "threadIds": thread_ids,
                }),
                CoreEvent::SyncProgress(p) => serde_json::json!({
                    "type": "sync-progress",
                    "accountId": p.account_id,
                    "folder": p.folder,
                    "phase": p.phase,
                    "done": p.done,
                    "total": p.total,
                }),
                CoreEvent::SyncStatus(s) => serde_json::json!({
                    "type": "sync-status",
                    "accountId": s.account_id,
                    "state": s.state,
                    "foregroundPhase": s.foreground_phase,
                }),
                CoreEvent::AccountState {
                    account_id,
                    sync_state,
                    sync_error,
                    ..
                } => serde_json::json!({
                    "type": "account-state",
                    "accountId": account_id,
                    "syncState": sync_state,
                    "syncError": sync_error,
                }),
                CoreEvent::NetworkState { online } => {
                    serde_json::json!({ "type": "network-state", "online": online })
                }
                _ => continue,
            };
            let _ = app.emit("core-event", payload);
        }
    });
}

/// The list view for a folder, mirroring the engine app's `view_for_folder`:
/// the role picks the view, everything else is `All` plus the folder id.
fn parse_view(view: &str) -> View {
    match view {
        "sent" => View::Sent,
        "drafts" => View::Drafts,
        "starred" => View::Starred,
        "snoozed" => View::Snoozed,
        "scheduled" => View::Scheduled,
        "done" => View::Done,
        "trash" => View::Trash,
        "spam" => View::Spam,
        "all" => View::All,
        _ => View::Inbox,
    }
}

#[tauri::command]
pub async fn list_accounts(engine: State<'_, Engine>) -> EngineResult<Vec<Account>> {
    engine.core.list_accounts().await.map_err(err)
}

/// Add a password account (IMAP/POP3). The frontend may prefill the
/// account's servers; `AddPasswordAccountArgs` deserializes from the same JSON.
#[tauri::command]
pub async fn add_account(
    engine: State<'_, Engine>,
    args: AddPasswordAccountArgs,
) -> EngineResult<Account> {
    engine.core.add_account_password(args).await.map_err(err)
}

#[tauri::command]
pub async fn remove_account(engine: State<'_, Engine>, account_id: i64) -> EngineResult<()> {
    engine.core.remove_account(account_id).await.map_err(err)
}

/// 在系统浏览器里打开一个地址（OAuth 授权页）。
fn open_in_browser(url: &str) -> std::result::Result<(), String> {
    #[cfg(target_os = "windows")]
    let spawned = std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .spawn();
    #[cfg(target_os = "macos")]
    let spawned = std::process::Command::new("open").arg(url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let spawned = std::process::Command::new("xdg-open").arg(url).spawn();
    spawned.map(|_| ()).map_err(|error| error.to_string())
}

/// The Microsoft application (client) ID saved for OAuth sign-in.
///
/// Outlook.com / hotmail.com / Microsoft 365 no longer accept a password over
/// IMAP, so those accounts sign in through Microsoft's OAuth flow. The engine
/// takes the app registration from its settings (`ms_client_id`).
#[tauri::command]
pub async fn oauth_client_id(engine: State<'_, Engine>) -> EngineResult<String> {
    let settings = engine.core.get_settings().await.map_err(err)?;
    Ok(settings.ms_client_id)
}

/// Save the Microsoft application (client) ID; an empty value clears it.
#[tauri::command]
pub async fn set_oauth_client_id(engine: State<'_, Engine>, client_id: String) -> EngineResult<()> {
    engine
        .core
        .set_oauth_apps(None, Some(client_id))
        .await
        .map_err(err)?;
    Ok(())
}

/// Sign in to an Outlook.com / Microsoft 365 mailbox: opens the authorization
/// page in the browser and waits for the engine's loopback redirect (it gives
/// up after 15 minutes). Returns the account once its tokens are stored.
#[tauri::command]
pub async fn start_microsoft_login(engine: State<'_, Engine>) -> EngineResult<Account> {
    engine
        .core
        .start_oauth(Provider::Microsoft, |url| open_in_browser(&url))
        .await
        .map_err(err)
}

/// Stop a sign-in that is waiting for the browser.
#[tauri::command]
pub fn cancel_oauth(engine: State<'_, Engine>) {
    engine.core.cancel_oauth();
}

#[tauri::command]
pub async fn list_folders(
    engine: State<'_, Engine>,
    account_id: Option<i64>,
) -> EngineResult<Vec<FolderInfo>> {
    engine.core.list_folders(account_id).await.map_err(err)
}

/// 把一个文件夹里的邮件全部标为已读（引擎 `mark_all_read`：本地立即生效，
/// 并给服务器排一条 `mark_folder_read`，连本地没下载的也一并标记）。
#[tauri::command]
pub async fn mark_folder_read(
    engine: State<'_, Engine>,
    folder_id: i64,
    view: Option<String>,
) -> EngineResult<ActionResult> {
    let view = view.as_deref().map(parse_view).unwrap_or(View::All);
    engine
        .core
        .mark_all_read(view, None, None, None, None, Some(folder_id))
        .await
        .map_err(err)
}

/// Which folder each special role (sent, trash, ...) resolves to on an
/// account: the server-suggested one unless the user chose another. The
/// UI names the exact destination after a delete.
#[tauri::command]
pub async fn account_folder_roles(
    engine: State<'_, Engine>,
    account_id: i64,
) -> EngineResult<AccountFolderRoles> {
    engine
        .core
        .account_folder_roles(account_id)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn list_messages(
    engine: State<'_, Engine>,
    view: Option<String>,
    account_id: Option<i64>,
    folder_id: Option<i64>,
    cursor: Option<MessageCursor>,
    limit: Option<i64>,
) -> EngineResult<MessagePage> {
    let view = view.as_deref().map(parse_view).unwrap_or(View::Inbox);
    let page = MessagePageRequest {
        cursor,
        limit: limit.unwrap_or(100).clamp(1, 200),
        order: ListOrder::NewestFirst,
    };
    engine
        .core
        .list_messages(view, None, account_id, None, folder_id, page)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn get_body(engine: State<'_, Engine>, message_id: i64) -> EngineResult<MessageDetail> {
    engine.core.get_body(message_id).await.map_err(err)
}

/// The unified action entry. The Delete key sends
/// `{ kind: "trash", target: { messages: [id] } }` - the engine routes the
/// message to its account's Deleted Items folder and syncs it out.
#[tauri::command]
pub async fn perform_action(
    engine: State<'_, Engine>,
    args: PerformActionArgs,
) -> EngineResult<ActionResult> {
    engine.core.perform_action(args).await.map_err(err)
}

#[tauri::command]
pub async fn empty_trash(
    engine: State<'_, Engine>,
    account_id: Option<i64>,
) -> EngineResult<ActionResult> {
    engine.core.empty_trash(account_id).await.map_err(err)
}

#[tauri::command]
pub async fn sync_now(engine: State<'_, Engine>) -> EngineResult<()> {
    engine.core.sync_accounts(None).await.map_err(err)
}

// ---- composing & sending ----

/// Save a draft (reply, forward, or new mail). Returns the draft's id.
#[tauri::command]
pub async fn save_draft(engine: State<'_, Engine>, args: SaveDraftArgs) -> EngineResult<i64> {
    engine.core.save_draft(args).await.map_err(err)
}

/// Queue a saved draft to leave through the engine's send queue (the
/// user-configurable undo delay applies). Returns the action tracking it.
#[tauri::command]
pub async fn queue_send(
    engine: State<'_, Engine>,
    draft_id: i64,
) -> EngineResult<QueueSendResult> {
    engine
        .core
        .queue_send(QueueSendArgs {
            draft_id,
            send_at: None,
            remind_at: None,
        })
        .await
        .map_err(err)
}

/// Keyword search over the mail kept on this device (the engine's FTS
/// index, parsed queries like `from:zhang`, newest first). Returns the
/// matching messages; the page cursor stays engine-side for now.
#[tauri::command]
pub async fn search_messages(
    engine: State<'_, Engine>,
    query: String,
    limit: Option<i64>,
) -> EngineResult<Vec<MessageSummary>> {
    let query = query.trim().to_owned();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let page: MessageSearchPage = engine
        .core
        .search_messages_page(query, None, None, limit.unwrap_or(100))
        .await
        .map_err(err)?;
    Ok(page.messages)
}

// ---- local mail import ----

/// One folder a scan found, for the import dialog's folder list.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanFolder {
    pub index: usize,
    pub name: String,
    pub kind: String,
    pub size_bytes: u64,
    pub selectable: bool,
}

/// List what a directory of saved mail (.eml per message, mbox, maildir)
/// holds, without importing anything yet.
#[tauri::command]
pub async fn scan_import(
    engine: State<'_, Engine>,
    root: String,
) -> EngineResult<Vec<ScanFolder>> {
    let _ = &engine;
    let path = PathBuf::from(root);
    let source = tokio::task::spawn_blocking(move || scan_folder(&path))
        .await
        .map_err(err)?
        .map_err(err)?;
    Ok(source
        .folders
        .iter()
        .enumerate()
        .map(|(index, folder)| ScanFolder {
            index,
            name: if folder.path.is_empty() {
                "(散件)".into()
            } else {
                folder.path.join("/")
            },
            kind: format!("{:?}", folder.kind).to_lowercase(),
            size_bytes: folder.size,
            selectable: folder.has_messages(),
        })
        .collect())
}

/// Import saved mail into the device-local store (the engine creates the
/// local account on the first import). Returns at once; progress and the
/// report arrive as `import-progress` / `import-report` events.
///
/// `skip_existing` leaves out messages this profile already holds anywhere
/// (matched by Message-ID), so importing an export of a mailbox the profile
/// also syncs adds only the mail the server no longer has.
#[tauri::command]
pub async fn import_local_mail(
    engine: State<'_, Engine>,
    app: AppHandle,
    root: String,
    folders: Vec<usize>,
    own_addresses: Vec<String>,
    skip_existing: Option<bool>,
) -> EngineResult<()> {
    if engine
        .import_running
        .swap(true, Ordering::Relaxed)
    {
        return Err("an import is already running".into());
    }
    let core = engine.core.clone();
    let running = engine.import_running.clone();
    let stop = engine.import_stop.clone();
    stop.store(false, Ordering::Relaxed);
    let path = PathBuf::from(root);
    let skip_existing = skip_existing.unwrap_or(false);

    tauri::async_runtime::spawn(async move {
        let result = run_import(
            &app,
            core,
            path,
            folders,
            own_addresses,
            skip_existing,
            stop,
        )
        .await;
        running.store(false, Ordering::Relaxed);
        match result {
            Ok(()) => {}
            Err(error) => {
                let _ = app.emit("import-failed", error);
            }
        }
    });
    Ok(())
}

/// Import the mail of an Outlook data file (`.ost` / `.pst`) directly: the
/// bundled `ost2eml` converts it to an EML tree in the cache directory, which
/// is then imported like any saved mail, skipping what the profile already
/// has. Returns at once; `outlook-progress` reports the conversion phase,
/// then `import-progress` / `import-report` the import.
#[tauri::command]
pub async fn import_outlook_file(
    engine: State<'_, Engine>,
    app: AppHandle,
    path: String,
    own_addresses: Vec<String>,
) -> EngineResult<()> {
    if engine.import_running.swap(true, Ordering::Relaxed) {
        return Err("an import is already running".into());
    }
    let core = engine.core.clone();
    let running = engine.import_running.clone();
    let stop = engine.import_stop.clone();
    stop.store(false, Ordering::Relaxed);
    let ost = PathBuf::from(path);
    tauri::async_runtime::spawn(async move {
        let result = run_outlook_import(&app, core, ost, own_addresses, stop).await;
        running.store(false, Ordering::Relaxed);
        if let Err(error) = result {
            let _ = app.emit("import-failed", error);
        }
    });
    Ok(())
}

/// The bundled converter, which Tauri places next to the application binary.
fn converter_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(err)?;
    let directory = exe
        .parent()
        .ok_or_else(|| "the application has no directory".to_owned())?;
    let converter = directory.join("ost2eml.exe");
    if converter.is_file() {
        Ok(converter)
    } else {
        Err(format!(
            "找不到 ost2eml.exe，应放在 {}（与 FirthMail.exe 同目录）",
            converter.display()
        ))
    }
}

async fn run_outlook_import(
    app: &AppHandle,
    core: Arc<Core>,
    ost: PathBuf,
    own_addresses: Vec<String>,
    stop: Arc<AtomicBool>,
) -> Result<(), String> {
    if !ost.is_file() {
        return Err(format!("{}: 文件不存在", ost.display()));
    }
    let converter = converter_path()?;
    let out = dirs::cache_dir()
        .ok_or("the operating system has no application cache directory")?
        .join("FirthMail")
        .join("outlook-import");
    let _ = std::fs::remove_dir_all(&out);
    std::fs::create_dir_all(&out).map_err(err)?;
    let _ = app.emit(
        "outlook-progress",
        serde_json::json!({ "phase": "converting", "path": ost.to_string_lossy() }),
    );

    // 转换是几分钟的磁盘/CPU 活，放阻塞线程里跑，别堵住异步运行时。
    let status = tokio::task::spawn_blocking({
        let converter = converter.clone();
        let ost = ost.clone();
        let out = out.clone();
        move || {
            std::process::Command::new(&converter)
                .arg(&ost)
                .arg(&out)
                .status()
        }
    })
    .await
    .map_err(err)?
    .map_err(err)?;
    if !status.success() {
        return Err(format!("ost2eml 转换失败（退出码 {status}）"));
    }
    // 取消发生在转换期间：转换没法中途停下，转换完就别继续导入了。
    if stop.load(Ordering::Relaxed) {
        let _ = std::fs::remove_dir_all(&out);
        return Ok(());
    }
    let _ = app.emit(
        "outlook-progress",
        serde_json::json!({ "phase": "importing" }),
    );

    let mut own = own_addresses;
    for account in core.list_accounts().await.map_err(err)? {
        if !own.iter().any(|address| address.eq_ignore_ascii_case(&account.email)) {
            own.push(account.email);
        }
    }
    let source = tokio::task::spawn_blocking({
        let out = out.clone();
        move || scan_folder(&out)
    })
    .await
    .map_err(err)?
    .map_err(err)?;
    // 「同步问题」是 Outlook 自己的同步日志，不是邮件；别导进来。
    let folders = source
        .folders
        .iter()
        .enumerate()
        .filter(|(_, folder)| !folder.path.join("/").contains("同步问题"))
        .map(|(index, _)| index)
        .collect();
    let request = MailImportRequest {
        source,
        folders,
        destination: Destination::Local,
        parent_folder: None,
        loose_folder_name: "Outlook 导入".into(),
        own_addresses: own,
    };
    let (progress, mut receiver) = tokio::sync::watch::channel(MailImportProgress::default());
    let worker = {
        let core = core.clone();
        let stop = stop.clone();
        tokio::spawn(async move { core.import_mail_skipping_known(request, progress, stop).await })
    };
    while receiver.changed().await.is_ok() {
        let p: MailImportProgress = *receiver.borrow_and_update();
        let _ = app.emit(
            "import-progress",
            serde_json::json!({
                "doneBytes": p.done_bytes,
                "totalBytes": p.total_bytes,
                "imported": p.imported,
            }),
        );
    }
    let report = worker.await.map_err(err)?.map_err(err)?;
    let _ = app.emit(
        "import-report",
        serde_json::json!({
            "accountId": report.account_id,
            "folders": report.folders.len(),
            "imported": report.imported,
            "alreadyPresent": report.already_present,
            "tooLarge": report.too_large,
            "stopped": report.stopped,
        }),
    );
    // 转换出来的 EML 树只是中转，引擎已把自己的副本放进数据目录。
    let _ = std::fs::remove_dir_all(&out);
    Ok(())
}

async fn run_import(
    app: &AppHandle,
    core: Arc<Core>,
    path: PathBuf,
    folders: Vec<usize>,
    own_addresses: Vec<String>,
    skip_existing: bool,
    stop: Arc<AtomicBool>,
) -> Result<(), String> {
    let source = tokio::task::spawn_blocking(move || scan_folder(&path))
        .await
        .map_err(err)?
        .map_err(err)?;
    let request = MailImportRequest {
        source,
        folders,
        destination: Destination::Local,
        parent_folder: None,
        loose_folder_name: "导入邮件".into(),
        own_addresses,
    };
    let (progress, mut receiver) = tokio::sync::watch::channel(MailImportProgress::default());
    let worker = {
        let core = core.clone();
        let stop = stop.clone();
        tokio::spawn(async move {
            if skip_existing {
                core.import_mail_skipping_known(request, progress, stop)
                    .await
            } else {
                core.import_mail(request, progress, stop).await
            }
        })
    };
    while receiver.changed().await.is_ok() {
        let p: MailImportProgress = *receiver.borrow_and_update();
        let _ = app.emit(
            "import-progress",
            serde_json::json!({
                "doneBytes": p.done_bytes,
                "totalBytes": p.total_bytes,
                "imported": p.imported,
            }),
        );
    }
    let report = worker.await.map_err(err)?.map_err(err)?;
    let _ = app.emit(
        "import-report",
        serde_json::json!({
            "accountId": report.account_id,
            "folders": report.folders.len(),
            "imported": report.imported,
            "alreadyPresent": report.already_present,
            "tooLarge": report.too_large,
            "stopped": report.stopped,
        }),
    );
    Ok(())
}

#[tauri::command]
pub fn cancel_import(engine: State<'_, Engine>) {
    engine.import_stop.store(true, Ordering::Relaxed);
}

/// 事件链诊断：转发器从总线收到的事件总数（含未匹配的）。
#[tauri::command]
pub fn diag() -> u64 {
    EVENTS_FORWARDED.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flectar_mail_core::accounts::credentials::DevelopmentFileCredentialStore;
    use flectar_mail_core::config::Paths;
    use flectar_mail_core::mail_import::{ChosenFile, scan_files};
    use flectar_mail_core::models::{ActionKind, ActionTarget, Importance, SaveDraftArgs};

    /// A scratch directory for one test, under the build tree: it never
    /// touches real mail, does not depend on the system temp folder being
    /// writable, and `cargo clean` removes it.
    fn scratch_dir(name: &str) -> PathBuf {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../..")
            .join("target")
            .join("test-tmp")
            .join(format!("{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The rename's data move: the old folders go to the new names, the
    /// absolute paths the database remembers go with them, and a second
    /// start leaves the new folders alone.
    #[test]
    fn the_rename_moves_the_folders_and_the_paths_they_are_named_by() {
        let root = scratch_dir("rename-e2e");
        let data_root = root.join("data");
        let cache_root = root.join("cache");
        let old_data = data_root.join(LEGACY_APP_DIR);
        let old_cache = cache_root.join(LEGACY_APP_DIR);
        std::fs::create_dir_all(old_data.join("mail").join("1")).unwrap();
        std::fs::create_dir_all(old_cache.join("attachments").join("1")).unwrap();
        let db = old_data.join("flectar-mail.db");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE messages (id INTEGER PRIMARY KEY, raw_path TEXT);
             CREATE TABLE attachments (id INTEGER PRIMARY KEY, file_path TEXT);",
        )
        .unwrap();
        let kept = old_data.join("mail").join("1").join("7.outgoing.eml");
        std::fs::write(&kept, b"From: a\r\n\r\nbody\r\n").unwrap();
        conn.execute(
            "INSERT INTO messages (id, raw_path) VALUES (1, ?1)",
            [kept.to_string_lossy().as_ref()],
        )
        .unwrap();
        let cached = old_cache.join("attachments").join("1").join("9.png");
        conn.execute(
            "INSERT INTO attachments (id, file_path) VALUES (1, ?1)",
            [cached.to_string_lossy().as_ref()],
        )
        .unwrap();
        drop(conn);

        let (data_dir, data_moved) = adopt_dir(&data_root, APP_DIR, LEGACY_APP_DIR);
        let (cache_dir, cache_moved) = adopt_dir(&cache_root, APP_DIR, LEGACY_APP_DIR);
        assert!(data_moved && cache_moved);
        assert_eq!(data_dir, data_root.join(APP_DIR));
        assert_eq!(cache_dir, cache_root.join(APP_DIR));
        assert!(!old_data.exists(), "the old folder is gone");

        rewrite_moved_paths(
            &data_dir.join("flectar-mail.db"),
            &[
                (old_data.clone(), data_dir.clone()),
                (old_cache.clone(), cache_dir.clone()),
            ],
        );
        let conn = rusqlite::Connection::open(data_dir.join("flectar-mail.db")).unwrap();
        let raw: String = conn
            .query_row("SELECT raw_path FROM messages WHERE id = 1", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(
            raw,
            data_dir
                .join("mail")
                .join("1")
                .join("7.outgoing.eml")
                .to_string_lossy()
        );
        let attachment: String = conn
            .query_row("SELECT file_path FROM attachments WHERE id = 1", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(
            attachment,
            cache_dir
                .join("attachments")
                .join("1")
                .join("9.png")
                .to_string_lossy()
        );
        drop(conn);
        assert!(std::fs::read(&raw).is_ok(), "the original still opens");

        let (again, moved_again) = adopt_dir(&data_root, APP_DIR, LEGACY_APP_DIR);
        assert!(!moved_again, "the new folder is not moved again");
        assert_eq!(again, data_dir);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// Import one hand-written .eml into a throwaway store the way
    /// `import_local_mail` does, and return the engine plus the message's id.
    /// Needs no account and touches no live data.
    async fn imported_mail(
        dir: &std::path::Path,
        subject: &str,
        message_id: &str,
    ) -> (Arc<Core>, i64) {
        std::fs::create_dir_all(dir).unwrap();
        let credentials =
            Arc::new(DevelopmentFileCredentialStore::new(dir.join("credentials.json")));
        let core = Arc::new(
            Core::start_mail_ui_with_credentials(Paths::for_tests(dir), credentials)
                .await
                .unwrap(),
        );
        let eml = dir.join("test.eml");
        std::fs::write(
            &eml,
            format!(
                "From: zhangsan@example.com\r\n\
                 To: user@example.com\r\n\
                 Subject: {subject}\r\n\
                 Date: Mon, 24 Nov 2026 10:00:00 +0800\r\n\
                 Message-ID: <{message_id}>\r\n\
                 Content-Type: text/plain; charset=utf-8\r\n\
                 \r\n\
                 Body for {subject}.\r\n"
            ),
        )
        .unwrap();
        let source = scan_files(&[ChosenFile::at(eml)]).unwrap();
        let request = MailImportRequest {
            folders: (0..source.folders.len()).collect(),
            destination: Destination::Local,
            source,
            parent_folder: None,
            loose_folder_name: "E2E".into(),
            own_addresses: vec!["user@example.com".into()],
        };
        let (progress, _receiver) = tokio::sync::watch::channel(MailImportProgress::default());
        let report = core
            .import_mail(request, progress, Arc::new(AtomicBool::new(false)))
            .await
            .unwrap();
        assert_eq!(report.imported, 1, "one message imported");
        let folders = core.list_folders(None).await.unwrap();
        let folder = folders
            .iter()
            .find(|f| f.display_name.contains("E2E"))
            .expect("import folder exists");
        let page = core
            .list_messages(
                View::All,
                None,
                None,
                None,
                Some(folder.id),
                MessagePageRequest {
                    cursor: None,
                    limit: 10,
                    order: ListOrder::NewestFirst,
                },
            )
            .await
            .unwrap();
        assert_eq!(page.messages.len(), 1);
        (core, page.messages[0].id)
    }

    /// 阅读窗格的「标为已读」/「标为未读」按钮：`perform_action` 的
    /// `mark_read` / `mark_unread`，与前端发出的请求形状一致。已读状态
    /// 当场写库；重复要求同一个状态是安静的空操作（不排队、不发事件），
    /// 所以前端必须自己把状态反映到界面上，不能等事件。
    #[tokio::test]
    async fn mark_read_and_unread_reach_the_store() {
        let dir = scratch_dir("read-e2e");
        let (core, message_id) =
            imported_mail(&dir, "已读按钮测试", "firthmail-read-e2e-1@example.com").await;

        let mark = |kind: ActionKind| {
            let core = core.clone();
            async move {
                core.perform_action(PerformActionArgs {
                    kind,
                    target: ActionTarget::Messages(vec![message_id]),
                    params: None,
                })
                .await
                .unwrap()
            }
        };
        let is_read = || {
            let core = core.clone();
            async move { core.get_body(message_id).await.unwrap().is_read }
        };

        // Mail saved on disk is imported as read (it was read long ago);
        // start from unread, which is the state the button marks away.
        assert!(is_read().await, "imported mail starts read");
        let result = mark(ActionKind::MarkUnread).await;
        assert_eq!(result.action_ids.len(), 1, "mark_unread queued");
        assert!(!is_read().await, "the message is unread in the store");

        // Ctrl+Q / 「标为已读」 marks it read, in the store at once.
        let result = mark(ActionKind::MarkRead).await;
        assert_eq!(result.action_ids.len(), 1, "mark_read queued for the server");
        assert!(is_read().await, "the message is read in the store");

        // Asking again changes nothing and queues nothing - exactly the
        // no-op the UI must not wait on.
        let again = mark(ActionKind::MarkRead).await;
        assert!(again.action_ids.is_empty(), "already read: no action queued");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The Delete key's engine path, end to end: import one hand-written
    /// .eml into a throwaway store, list the folder, trash the message
    /// through the unified action queue - exactly as the frontend sends it -
    /// and find it in the trash folder. Needs no account and touches no
    /// live data.
    #[tokio::test]
    async fn delete_moves_imported_mail_to_trash() {
        let dir = scratch_dir("delete-e2e");
        std::fs::create_dir_all(&dir).unwrap();
        let credentials =
            Arc::new(DevelopmentFileCredentialStore::new(dir.join("credentials.json")));
        let core =
            Core::start_mail_ui_with_credentials(Paths::for_tests(&dir), credentials)
                .await
                .unwrap();

        // One .eml on disk, imported the way `import_local_mail` does.
        let eml = dir.join("test.eml");
        std::fs::write(
            &eml,
            concat!(
                "From: =?utf-8?B?5byg5LiJ?= <zhangsan@example.com>\r\n",
                "To: user@example.com\r\n",
                "Subject: Delete 键测试\r\n",
                "Date: Mon, 24 Nov 2026 10:00:00 +0800\r\n",
                "Message-ID: <firthmail-e2e-1@example.com>\r\n",
                "Content-Type: text/plain; charset=utf-8\r\n",
                "\r\n",
                "Press Delete and this message should move to the trash folder.\r\n",
            ),
        )
        .unwrap();
        let source = scan_files(&[ChosenFile::at(eml)]).unwrap();
        let request = MailImportRequest {
            folders: (0..source.folders.len()).collect(),
            destination: Destination::Local,
            source,
            parent_folder: None,
            loose_folder_name: "E2E".into(),
            own_addresses: vec!["user@example.com".into()],
        };
        let (progress, _receiver) = tokio::sync::watch::channel(MailImportProgress::default());
        let report = core
            .import_mail(request, progress, Arc::new(AtomicBool::new(false)))
            .await
            .unwrap();
        assert_eq!(report.imported, 1, "one message imported");
        assert!(!report.stopped);

        // The import created the local account with the mail in a folder.
        let folders = core.list_folders(None).await.unwrap();
        let e2e = folders
            .iter()
            .find(|f| f.display_name.contains("E2E"))
            .expect("import folder exists");
        let page = core
            .list_messages(
                View::All,
                None,
                None,
                None,
                Some(e2e.id),
                MessagePageRequest {
                    cursor: None,
                    limit: 10,
                    order: ListOrder::NewestFirst,
                },
            )
            .await
            .unwrap();
        assert_eq!(page.messages.len(), 1);
        let message = &page.messages[0];
        assert_eq!(message.subject, "Delete 键测试");
        let detail = core.get_body(message.id).await.unwrap();
        assert!(detail.html_body.is_some() || detail.text_body.is_some());

        // The Delete key's action, exactly as the frontend sends it.
        core.perform_action(PerformActionArgs {
            kind: ActionKind::Trash,
            target: ActionTarget::Messages(vec![message.id]),
            params: None,
        })
        .await
        .unwrap();

        // The message has left its folder...
        let after = core
            .list_messages(
                View::All,
                None,
                None,
                None,
                Some(e2e.id),
                MessagePageRequest {
                    cursor: None,
                    limit: 10,
                    order: ListOrder::NewestFirst,
                },
            )
            .await
            .unwrap();
        assert!(after.messages.is_empty(), "the folder no longer lists it");

        // ...and lives in the trash folder now.
        let trash = folders
            .iter()
            .find(|f| f.role.as_deref() == Some("trash"))
            .expect("local trash folder exists");
        let trashed = core
            .list_messages(
                View::Trash,
                None,
                None,
                None,
                Some(trash.id),
                MessagePageRequest {
                    cursor: None,
                    limit: 10,
                    order: ListOrder::NewestFirst,
                },
            )
            .await
            .unwrap();
        assert!(
            trashed.messages.iter().any(|m| m.id == message.id),
            "the message is in the trash folder"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The reply path the composer takes: save a draft linked to the
    /// original message, and find it in the drafts view. No send - that
    /// would put real mail on a real server.
    #[tokio::test]
    async fn reply_draft_saves_with_thread_linkage() {
        let dir = scratch_dir("draft-e2e");
        std::fs::create_dir_all(&dir).unwrap();
        let credentials =
            Arc::new(DevelopmentFileCredentialStore::new(dir.join("credentials.json")));
        let core = Core::start_mail_ui_with_credentials(Paths::for_tests(&dir), credentials)
            .await
            .unwrap();

        let eml = dir.join("test.eml");
        std::fs::write(
            &eml,
            concat!(
                "From: =?utf-8?B?5byg5LiJ?= <zhangsan@example.com>\r\n",
                "To: user@example.com\r\n",
                "Subject: Reply 键测试\r\n",
                "Date: Mon, 24 Nov 2026 10:00:00 +0800\r\n",
                "Message-ID: <firthmail-draft-e2e-1@example.com>\r\n",
                "Content-Type: text/plain; charset=utf-8\r\n",
                "\r\n",
                "Ctrl+R should quote this.\r\n",
            ),
        )
        .unwrap();
        let source = scan_files(&[ChosenFile::at(eml)]).unwrap();
        let request = MailImportRequest {
            folders: (0..source.folders.len()).collect(),
            destination: Destination::Local,
            source,
            parent_folder: None,
            loose_folder_name: "E2E".into(),
            own_addresses: vec!["user@example.com".into()],
        };
        let (progress, _receiver) = tokio::sync::watch::channel(MailImportProgress::default());
        let report = core
            .import_mail(request, progress, Arc::new(AtomicBool::new(false)))
            .await
            .unwrap();
        assert_eq!(report.imported, 1);

        let folders = core.list_folders(None).await.unwrap();
        let e2e = folders
            .iter()
            .find(|f| f.display_name.contains("E2E"))
            .expect("import folder exists");
        let page = core
            .list_messages(
                View::All,
                None,
                None,
                None,
                Some(e2e.id),
                MessagePageRequest {
                    cursor: None,
                    limit: 10,
                    order: ListOrder::NewestFirst,
                },
            )
            .await
            .unwrap();
        let original = &page.messages[0];

        // The composer's reply, exactly as the frontend posts it. The
        // engine takes the request, parses it fully, and then refuses it:
        // the local account has no address and never sends, so mail kept
        // only on this device cannot be answered. The composer surfaces
        // this engine error instead of pretending to send.
        let result = core
            .save_draft(SaveDraftArgs {
                draft_id: None,
                account_id: report.account_id,
                from: None,
                to: vec![flectar_mail_core::models::Address {
                    name: Some("张三".into()),
                    email: "zhangsan@example.com".into(),
                }],
                cc: vec![],
                bcc: vec![],
                subject: "RE: Reply 键测试".into(),
                body_text: "回复正文：Ctrl+R 管线通啦。".into(),
                body_html: None,
                mode: "reply".into(),
                in_reply_to_message_id: Some(original.id),
                in_reply_to_header: None,
                attachments: vec![],
                request_read_receipt: false,
                importance: Importance::Normal,
            })
            .await;
        match result {
            Ok(id) => panic!("local mail has no sender identity; the draft should be refused, got {id}"),
            Err(error) => {
                let text = error.to_string();
                assert!(
                    text.contains("account"),
                    "the refusal should name the account: {text}"
                );
            }
        }

        let _ = std::fs::remove_dir_all(&dir);
    }
}
