import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import AccountSetup from './components/AccountSetup';
import Composer, { type ComposeMode } from './components/Composer';
import FolderTree from './components/FolderTree';
import ImportModal from './components/ImportModal';
import MessageList from './components/MessageList';
import ReadingPane from './components/ReadingPane';
import { api } from './api';
import {
  autoReadDue,
  readActionKind,
  startsAutoReadWait,
  toggledReadState,
  type AutoReadWait,
} from './readMarking';
import type { EngineAccount, EngineFolder, EngineMessage, EngineMessageDetail } from './types';

/** The list view for a folder, mirroring the engine app's `view_for_folder`. */
function viewForRole(role?: string | null): string {
  switch (role) {
    case 'inbox':
      return 'inbox';
    case 'sent':
      return 'sent';
    case 'drafts':
      return 'drafts';
    case 'archive':
      return 'done';
    case 'trash':
      return 'trash';
    case 'spam':
      return 'spam';
    default:
      return 'all';
  }
}

/**
 * How long an opened message stays in the reading pane before it counts as
 * read: long enough to skim the first lines, short enough to feel automatic.
 */
const AUTO_READ_DELAY_MS = 3000;

/**
 * FirthMail shell over the flectar-mail-core engine: three panes, keyboard
 * first.
 *
 * The keyboard map is the point of this client: Delete in the message list
 * moves the mail to its account's Deleted Items folder; the action travels
 * through the engine's durable queue and syncs to the server.
 */
export default function App() {
  const [accounts, setAccounts] = useState<EngineAccount[]>([]);
  const [folders, setFolders] = useState<EngineFolder[]>([]);
  const [folderId, setFolderId] = useState<number | null>(null);
  const [rows, setRows] = useState<EngineMessage[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [body, setBody] = useState<EngineMessageDetail | null>(null);
  const [status, setStatus] = useState('启动中…');
  const [toast, setToast] = useState<string | null>(null);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState<string | null>(null);
  const [eventCount, setEventCount] = useState(0);
  const [backendEvents, setBackendEvents] = useState<number | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [compose, setCompose] = useState<{ mode: ComposeMode } | null>(null);

  const folderIdRef = useRef<number | null>(null);
  folderIdRef.current = folderId;
  const viewRef = useRef<string>('all');
  const rowsRef = useRef<EngineMessage[]>([]);
  rowsRef.current = rows;
  const selectedRef = useRef<number | null>(null);
  selectedRef.current = selectedId;
  const searchRef = useRef<string | null>(null);
  searchRef.current = search;
  const accountsRef = useRef<EngineAccount[]>([]);
  accountsRef.current = accounts;
  /** 阅读窗格里停留够久就自动标已读：记录等待中的邮件，手动切换后不再自动。 */
  const autoReadRef = useRef<AutoReadWait>({
    id: null,
    suppressed: false,
  });

  const showToast = useCallback((text: string) => {
    setToast(text);
    window.setTimeout(() => setToast(null), 2200);
  }, []);

  const loadRows = useCallback(async (fid: number | null, view: string) => {
    // 只在文件夹切换时清空阅读窗格；同文件夹的刷新（事件、删除后）保留它。
    const folderChanged = fid !== folderIdRef.current;
    viewRef.current = view;
    try {
      const page = await api.listMessages(fid, view);
      setRows(page.messages);
      if (folderChanged) setBody(null);
    } catch (e) {
      setStatus(String(e));
    }
  }, []);

  /** 引擎 FTS 搜索（支持 from:/to: 等语法），结果替代当前列表。 */
  const runSearch = useCallback(async (query: string) => {
    const q = query.trim();
    if (!q) {
      clearSearch();
      return;
    }
    setSearch(q);
    try {
      const list = await api.searchMessages(q);
      setRows(list);
      setBody(null);
      setSelectedId(list.length > 0 ? list[0].id : null);
      setStatus(`搜索“${q}”：${list.length} 封`);
    } catch (e) {
      setStatus(String(e));
    }
  }, []);

  const clearSearch = useCallback(() => {
    setSearch(null);
    setSearchInput('');
    void loadRows(folderIdRef.current, viewRef.current);
  }, [loadRows]);

  const refreshFolders = useCallback(async () => {
    try {
      const fs = await api.listFolders(null);
      setFolders(fs);
      return fs;
    } catch (e) {
      setStatus(String(e));
      return [];
    }
  }, []);

  const bootstrap = useCallback(async () => {
    try {
      const accs = await api.listAccounts();
      setAccounts(accs);
      if (accs.length === 0) {
        setSetupOpen(true);
        setStatus('请先添加邮箱账户');
        return;
      }
      const fs = await refreshFolders();
      const pickable = fs.find((f) => f.selectable && f.role === 'inbox') ?? fs.find((f) => f.selectable);
      if (pickable) {
        setFolderId(pickable.id);
        await loadRows(pickable.id, viewForRole(pickable.role));
      }
      setStatus(
        accs
          .map((a) => `${a.email} · ${a.syncState}`)
          .join('  |  '),
      );
    } catch (e) {
      setStatus(String(e));
    }
  }, [loadRows, refreshFolders]);

  useEffect(() => {
    bootstrap();
    // 事件链诊断：10 秒后问一次后端转发器收到了多少（前端计数与它对比）。
    const diagTimer = window.setTimeout(() => {
      api
        .diag()
        .then((n) => setBackendEvents(n))
        .catch(() => {});
    }, 10000);
    const unlisten = listen('core-event', (event) => {
      const payload = event.payload as Record<string, unknown>;
      const type = payload.type as string;
      setEventCount((c) => c + 1);
      if (type === 'mail-updated' || type === 'mail-new') {
        // A folder's mail changed (sync, move, delete). Refresh what is on
        // screen; the engine's action queue settles server-side on its own.
        if (searchRef.current) {
          api
            .searchMessages(searchRef.current)
            .then((list) => setRows(list))
            .catch(() => {});
        } else {
          loadRows(folderIdRef.current, viewRef.current);
        }
        refreshFolders();
      } else if (type === 'sync-progress') {
        const folder = payload.folder as string;
        const done = payload.done as number;
        const total = payload.total as number;
        setStatus(`同步中 ${folder} ${done}/${total}`);
      } else if (type === 'account-state') {
        const email = accountsRef.current.find((a) => a.id === (payload.accountId as number))?.email ?? '';
        setStatus(`${email} · ${String(payload.syncState)}${payload.syncError ? ` · ${payload.syncError}` : ''}`);
        api.listAccounts().then(setAccounts).catch(() => {});
      } else if (type === 'network-state') {
        setStatus(payload.online ? '在线' : '离线');
      }
    });
    return () => {
      window.clearTimeout(diagTimer);
      unlisten.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openMessage = useCallback(async (id: number) => {
    setSelectedId(id);
    try {
      setBody(await api.getBody(id));
    } catch (e) {
      setStatus(String(e));
    }
  }, []);

  /** The engine's unified action queue: trash, mark read, move, star, ... */
  const act = useCallback(
    async (kind: string, params?: Record<string, unknown> | null) => {
      const id = selectedRef.current;
      if (id == null) return null;
      await api.performAction({ kind, target: { messages: [id] }, params: params ?? null });
      return id;
    },
    [],
  );

  /** Delete or Ctrl+D moves the message to 已删除邮件. */
  const deleteSelected = useCallback(async () => {
    const id = selectedRef.current;
    if (id == null) return;
    const current = rowsRef.current;
    const idx = current.findIndex((m) => m.id === id);
    const accountId = idx >= 0 ? current[idx].accountId : null;
    try {
      await act('trash');
    } catch (e) {
      setStatus(String(e));
      return;
    }
    // 引擎在 perform_action 的事务里就完成了本地移动；直接刷新列表，
    // 不等事件（那条 webview 腿还没证明）。选择先按列表顺序推进，
    // loadRows 不会再动有效选择。
    const next = current[idx + 1] ?? current[idx - 1] ?? null;
    if (next) {
      setSelectedId(next.id);
      openMessage(next.id);
    } else {
      setSelectedId(null);
      setBody(null);
    }
    await loadRows(folderIdRef.current, viewRef.current);
    await refreshFolders();
    // 有些服务器有两个废件夹（如 Trash 与 [根]/Trash）；提示里写明
    // 引擎实际选择的那个，免得去另一个文件夹里找不到。
    let target = '';
    try {
      if (accountId != null) {
        const { roles } = await api.accountFolderRoles(accountId);
        const trashRole = roles.find((r) => r.role === 'trash');
        const trashId = trashRole?.suggested ?? trashRole?.chosen ?? null;
        if (trashId != null) {
          const fs = await api.listFolders(null);
          target = fs.find((f) => f.id === trashId)?.displayName ?? '';
        }
      }
    } catch {
      // 角色信息拿不到不影响删除本身
    }
    showToast(target ? `已移入废纸篓（${target}）` : '已移入废纸篓');
  }, [act, openMessage, showToast, loadRows, refreshFolders]);

  /**
   * Mark the selected message read (`mark_read`) or unread (`mark_unread`)
   * through the engine's action queue.
   *
   * The engine skips the write when the message already has the wanted
   * state and then emits nothing, so an idempotent no-op would leave the UI
   * untouched. The result is therefore mirrored locally right away instead
   * of relying on the event: the row's unread dot and the reading pane's
   * toggle flip at once. A manual toggle also stops the auto-read wait for
   * this message, so marking one unread while it is open keeps it unread.
   */
  const setRead = useCallback(
    async (read: boolean) => {
      const id = selectedRef.current;
      if (id == null) return;
      autoReadRef.current = { id, suppressed: true };
      try {
        await act(readActionKind(read));
      } catch (e) {
        setStatus(String(e));
        return;
      }
      setRows((list) => list.map((m) => (m.id === id ? { ...m, isRead: read } : m)));
      setBody((current) => (current && current.id === id ? { ...current, isRead: read } : current));
    },
    [act],
  );

  /**
   * 自动已读：邮件在阅读窗格显示满 3 秒后标为已读。切换选中的邮件、
   * 或手动切换已读都会取消这次等待——被快速翻过的邮件保持未读。
   */
  useEffect(() => {
    if (!body || !startsAutoReadWait(body.isRead)) return;
    const id = body.id;
    if (autoReadRef.current.id !== id) {
      autoReadRef.current = { id, suppressed: false };
    }
    if (autoReadRef.current.suppressed) return;
    const timer = window.setTimeout(() => {
      if (!autoReadDue(autoReadRef.current, id, selectedRef.current)) return;
      autoReadRef.current = { id, suppressed: true };
      void setRead(true);
    }, AUTO_READ_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [body, setRead]);

  const reply = useCallback(() => {
    if (!body) {
      showToast('请先选择一封邮件');
      return;
    }
    setCompose({ mode: 'reply' });
  }, [body, showToast]);

  const forward = useCallback(() => {
    if (!body) {
      showToast('请先选择一封邮件');
      return;
    }
    setCompose({ mode: 'forward' });
  }, [body, showToast]);

  // The keyboard map. Delete first: that is the one this client exists to
  // get right.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      const mod = e.ctrlKey || e.metaKey;

      if (e.key === 'Delete' || (mod && e.key.toLowerCase() === 'd')) {
        e.preventDefault();
        void deleteSelected();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (rows.length === 0) return;
        e.preventDefault();
        const idx = rows.findIndex((m) => m.id === selectedId);
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        const next = rows[Math.min(Math.max(idx + delta, 0), rows.length - 1)];
        if (next) openMessage(next.id);
      } else if (e.key === 'Home') {
        e.preventDefault();
        if (rows.length > 0) openMessage(rows[0].id);
      } else if (e.key === 'End') {
        e.preventDefault();
        if (rows.length > 0) openMessage(rows[rows.length - 1].id);
      } else if (e.key === 'Escape') {
        if (search) {
          e.preventDefault();
          clearSearch();
        }
      } else if (mod && e.key.toLowerCase() === 'q') {
        e.preventDefault();
        void setRead(true);
      } else if (mod && e.key.toLowerCase() === 'u') {
        e.preventDefault();
        void setRead(false);
      } else if (mod && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        reply();
      } else if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        forward();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [rows, selectedId, deleteSelected, setRead, reply, forward, openMessage]);

  const grouped = useMemo(() => {
    const byAccount = new Map<number, { account: EngineAccount | undefined; folders: EngineFolder[] }>();
    for (const account of accounts) byAccount.set(account.id, { account, folders: [] });
    for (const f of folders) {
      if (!byAccount.has(f.accountId)) byAccount.set(f.accountId, { account: undefined, folders: [] });
      byAccount.get(f.accountId)!.folders.push(f);
    }
    return [...byAccount.values()];
  }, [accounts, folders]);

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-logo" aria-hidden="true">F</span>
          FirthMail
        </div>
        <input
          className="search"
          placeholder="搜索邮件（Enter 确认；支持 from:/to: 语法）"
          aria-label="搜索邮件"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              void runSearch(searchInput);
            }
          }}
        />
        <div className="header-actions">
          <button
            className="primary"
            onClick={() => {
              if (accounts.length === 0) {
                showToast('请先添加账户');
                setSetupOpen(true);
                return;
              }
              setCompose({ mode: 'new' });
            }}
          >
            ✉ 新邮件
          </button>
          <button className="primary" onClick={() => setImportOpen(true)}>📥 导入邮件</button>
          <button className="primary" onClick={() => setSetupOpen(true)}>✚ 添加账户</button>
        </div>
      </header>

      <div className="app-body">
        <FolderTree
          groups={grouped}
          activeId={folderId}
          onSelect={(folder) => {
            if (search) clearSearch();
            setFolderId(folder.id);
            loadRows(folder.id, viewForRole(folder.role));
          }}
        />
        <div className="list-column">
          {search && (
            <div className="search-banner">
              <span>搜索：“{search}”</span>
              <button className="link" onClick={clearSearch}>× 清除（Esc）</button>
            </div>
          )}
          <MessageList
            rows={rows}
            selectedId={selectedId}
            onSelect={(id) => openMessage(id)}
          />
        </div>
        <ReadingPane
          message={body}
          selected={selectedId}
          onReply={reply}
          onForward={forward}
          onDelete={() => void deleteSelected()}
          onToggleRead={() => {
            if (body) void setRead(toggledReadState(body.isRead));
          }}
        />
      </div>

      <footer className="app-footer">
        <span>{status}</span>
        <span className="footer-right">
          <em className={eventCount > 0 ? 'events-ok' : 'events-none'}>
            引擎事件 ×{eventCount}
            {backendEvents != null && `｜后端 ×${backendEvents}`}
          </em>
          <span className="kbd-hint">
            Delete 删除 · ↑↓ 选择 · Ctrl+Q 已读 · Ctrl+U 未读 · Ctrl+R 回复 · Ctrl+F 转发 · 停留 3 秒自动已读
          </span>
        </span>
      </footer>

      {toast && <div className="toast" role="status">{toast}</div>}
      {importOpen && (
        <ImportModal
          onClose={() => setImportOpen(false)}
          onImported={async () => {
            setImportOpen(false);
            showToast('导入完成');
            await bootstrap();
          }}
        />
      )}
      {setupOpen && (
        <AccountSetup
          onClose={() => setSetupOpen(false)}
          onAdded={async () => {
            setSetupOpen(false);
            setStatus('账户已添加，正在同步…');
            await bootstrap();
          }}
        />
      )}
      {compose && (
        <Composer
          mode={compose.mode}
          original={compose.mode === 'new' ? null : body}
          accountId={body?.accountId ?? accounts[0]?.id ?? null}
          onClose={() => setCompose(null)}
          onSent={(text) => {
            setCompose(null);
            showToast(text);
          }}
        />
      )}
    </div>
  );
}
