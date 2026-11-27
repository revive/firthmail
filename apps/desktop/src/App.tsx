import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import AccountSetup from './components/AccountSetup';
import AddressBook from './components/AddressBook';
import { ComposeForm, type ComposeMode } from './components/Composer';
import ConfirmDialog from './components/ConfirmDialog';
import ContextMenu, { type ContextMenuItem } from './components/ContextMenu';
import FolderTree from './components/FolderTree';
import ImportModal from './components/ImportModal';
import MailToolbar from './components/MailToolbar';
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
import type { EngineAddress } from './types';
import type { Contact } from './addressBook';
import { RequestGate } from './selection';
import { BodyCache } from './bodyCache';

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
  /** 每个文件夹的未读数，侧栏显示成「收件箱 (12)」。 */
  const [unreadByFolder, setUnreadByFolder] = useState<Record<number, number>>({});
  const [nextCursor, setNextCursor] = useState<{ date: number; messageId: number } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  /**
   * 同一个邮箱被拆成两个账户时（IMAP 同步的 + 从 Outlook 导入到本机的），
   * 按账户集合列同一个视图，让用户在收件箱里看到全部邮件。
   */
  const [merged, setMerged] = useState<{ accountIds: number[]; view: string } | null>(null);
  /** 当前列表是「本机副本 + 服务器」按路径对应的归并结果。 */
  const [paired, setPaired] = useState(false);
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
  /** 本地地址簿（名字 + 地址），写邮件时用来补全。 */
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [addressBookOpen, setAddressBookOpen] = useState(false);
  /** 待确认的清空操作：废纸篓/垃圾邮件可以整个清空。 */
  const [emptyConfirm, setEmptyConfirm] = useState<{
    id: number;
    name: string;
    role: string;
    accountId: number;
  } | null>(null);
  const [emptying, setEmptying] = useState(false);
  /** 右键菜单：文件夹或邮件，位置是视口坐标。 */
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    target: { kind: 'folder'; folder: EngineFolder } | { kind: 'message'; isRead: boolean };
  } | null>(null);
  /**
   * The open composer. Replies and forwards start inline in the reading pane
   * (the mail list stays put); 「弹出」 or a new message uses its own window.
   * `original` is a snapshot: the mail the reply or forward is about, kept
   * even if the user moves on in the list.
   */
  const [compose, setCompose] = useState<{
    mode: ComposeMode;
    replyAll: boolean;
    inline: boolean;
    original: EngineMessageDetail | null;
    /** 新邮件预填的收件人（点邮件地址进来时）。 */
    initialTo?: string;
  } | null>(null);

  const folderIdRef = useRef<number | null>(null);
  folderIdRef.current = folderId;
  const viewRef = useRef<string>('all');
  const rowsRef = useRef<EngineMessage[]>([]);
  rowsRef.current = rows;
  const selectedRef = useRef<number | null>(null);
  selectedRef.current = selectedId;
  const searchRef = useRef<string | null>(null);
  searchRef.current = search;
  /** Bumped for every body request, so a slow one can tell it is stale. */
  const bodyGate = useRef(new RequestGate());
  /** 最近读过的正文，来回翻时秒开。 */
  const bodyCache = useRef(new BodyCache());
  /** Bumped for every list load, so a slow folder/search answer is dropped. */
  const listGate = useRef(new RequestGate());
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

  /** 一页 200 封：引擎的上限，也是滚动加载的粒度。 */
  const PAGE_SIZE = 200;
  const nextCursorRef = useRef<{ date: number; messageId: number } | null>(null);
  nextCursorRef.current = nextCursor;
  const loadingMoreRef = useRef(false);
  const mergedRef = useRef<{ accountIds: number[]; view: string } | null>(null);
  mergedRef.current = merged;
  /**
   * 本机副本与 IMAP 文件夹按路径对应（例：两个 "Archives/2015"）。引擎一次只列
   * 一个文件夹，所以列表由两边各取一页、按日期归并；`pairRef` 保存两边的游标
   * 和预取的邮件。
   */
  const pairRef = useRef<{
    folders: number[];
    cursors: ({ date: number; messageId: number } | null)[];
    buffers: EngineMessage[][];
    /** 这一边已经取到最后一页了。 */
    done: boolean[];
  } | null>(null);
  const pairMoreRef = useRef(false);

  /** 归并取一页：哪边队首更新就取哪边，两边都没了就没有下一页。 */
  const nextPairPage = useCallback(async (count: number) => {
    const pair = pairRef.current;
    if (!pair) return { items: [] as EngineMessage[], more: false };
    const items: EngineMessage[] = [];
    const refill = async (side: number) => {
      // 第一次进来看的是游标 null（第一页），所以用 done 而不是游标判断结束。
      while (pair.buffers[side].length === 0 && !pair.done[side]) {
        const page = await api.listMessages(pair.folders[side], viewRef.current, 100, pair.cursors[side]);
        pair.buffers[side].push(...page.messages);
        pair.cursors[side] = page.nextCursor ?? null;
        pair.done[side] = page.nextCursor == null;
        if (page.messages.length === 0) {
          pair.done[side] = true;
        }
      }
    };
    while (items.length < count) {
      await refill(0);
      await refill(1);
      const [a] = pair.buffers[0];
      const [b] = pair.buffers[1];
      if (!a && !b) break;
      const takeA = a && (!b || a.date >= b.date);
      items.push((takeA ? pair.buffers[0].shift() : pair.buffers[1].shift())!);
    }
    const more =
      pair.buffers.some((buffer) => buffer.length > 0) || pair.done.some((done) => !done);
    return { items, more };
  }, []);

  const appendRows = useCallback((extra: EngineMessage[]) => {
    if (extra.length === 0) return;
    setRows((current) => {
      const known = new Set(current.map((message) => message.id));
      const fresh = extra.filter((message) => !known.has(message.id));
      return fresh.length > 0 ? [...current, ...fresh] : current;
    });
  }, []);

  const loadRows = useCallback(async (fid: number | null, view: string) => {
    // 只在文件夹切换时清空阅读窗格；同文件夹的刷新（事件、删除后）保留它。
    const folderChanged = fid !== folderIdRef.current;
    const mergedNow = mergedRef.current;
    viewRef.current = mergedNow?.view ?? view;
    const token = listGate.current.start();
    try {
      let loaded: EngineMessage[];
      if (mergedNow) {
        const page = await api.listMessagesMerged(mergedNow.accountIds, mergedNow.view, PAGE_SIZE);
        if (!listGate.current.current(token)) return;
        loaded = page.messages;
        setNextCursor(page.nextCursor ?? null);
      } else if (pairRef.current) {
        pairRef.current.cursors = [null, null];
        pairRef.current.buffers = [[], []];
        pairRef.current.done = [false, false];
        const page = await nextPairPage(PAGE_SIZE);
        if (!listGate.current.current(token)) return;
        loaded = page.items;
        pairMoreRef.current = page.more;
        setNextCursor(null);
      } else {
        const page = await api.listMessages(fid, view, PAGE_SIZE);
        if (!listGate.current.current(token)) return;
        loaded = page.messages;
        setNextCursor(page.nextCursor ?? null);
      }
      setRows(loaded);
      // 换了文件夹、或选中的那封已经不在列表里：清掉选择。否则阅读窗格会
      // 一直停在「正在载入邮件」（列表里已经没有它，没人会再去取正文）。
      const stillListed =
        selectedRef.current != null && loaded.some((m) => m.id === selectedRef.current);
      if (folderChanged || !stillListed) {
        selectedRef.current = null;
        setSelectedId(null);
        setBody(null);
        // 让还在路上的正文请求作废，别在窗格里冒出来。
        bodyGate.current.start();
      }
    } catch (e) {
      setStatus(String(e));
    }
  }, [nextPairPage]);

  /** 滚到列表底部时加载下一页，追加到现有列表后面。 */
  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current) return;
    const mergedNow = mergedRef.current;
    const pairing = pairRef.current;
    const atEnd = pairing ? !pairMoreRef.current : !nextCursorRef.current;
    if (atEnd) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    const token = listGate.current.start();
    try {
      if (pairing) {
        const page = await nextPairPage(PAGE_SIZE);
        if (!listGate.current.current(token)) return;
        pairMoreRef.current = page.more;
        appendRows(page.items);
      } else {
        const page = mergedNow
          ? await api.listMessagesMerged(mergedNow.accountIds, mergedNow.view, PAGE_SIZE, nextCursorRef.current)
          : await api.listMessages(folderIdRef.current, viewRef.current, PAGE_SIZE, nextCursorRef.current);
        // 这期间换了文件夹/搜索：这页属于旧列表，别追加进去。
        if (!listGate.current.current(token)) return;
        appendRows(page.messages);
        setNextCursor(page.nextCursor ?? null);
      }
    } catch (e) {
      setStatus(String(e));
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [nextPairPage, appendRows]);

  /** 搜索前记下列表模式（合并/本机副本归并），清除搜索时原样恢复。 */
  const savedListingRef = useRef<{
    merged: { accountIds: number[]; view: string } | null;
    pair: typeof pairRef.current;
  } | null>(null);

  /**
   * 动作（删除、归档……）之后刷新列表。
   *
   * 正在搜索时列表就是搜索结果：重新跑一次搜索，而不是把人踢回文件夹列表。
   */
  const reloadCurrent = useCallback(async () => {
    const query = searchRef.current;
    if (!query) {
      await loadRows(folderIdRef.current, viewRef.current);
      return;
    }
    try {
      const list = await api.searchMessages(query);
      if (searchRef.current !== query) return;
      setRows(list);
    } catch (e) {
      setStatus(String(e));
    }
  }, [loadRows]);

  /** 引擎 FTS 搜索（支持 from:/to: 等语法），结果替代当前列表。 */
  const runSearch = useCallback(async (query: string) => {
    const q = query.trim();
    if (!q) {
      clearSearch();
      return;
    }
    setSearch(q);
    savedListingRef.current = { merged: mergedRef.current, pair: pairRef.current };
    mergedRef.current = null;
    setMerged(null);
    pairRef.current = null;
    setPaired(false);
    const token = listGate.current.start();
    try {
      const list = await api.searchMessages(q);
      if (!listGate.current.current(token)) return;
      setRows(list);
      // 搜索结果不分页（引擎一次给完）。
      setNextCursor(null);
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
    const saved = savedListingRef.current;
    if (saved) {
      mergedRef.current = saved.merged;
      setMerged(saved.merged);
      pairRef.current = saved.pair;
      setPaired(saved.pair != null);
      savedListingRef.current = null;
    }
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

  /**
   * 侧栏每个文件夹的未读数。
   *
   * 引擎一次聚合就能给出全部文件夹的未读，但同步时会连续来一串事件，所以
   * 合并成一次刷新（400 ms 内只算一次）；本地标已读/删除后也调用它，数字
   * 立刻跟着动，不必等服务器。
   */
  const unreadTimer = useRef<number | null>(null);
  const refreshUnread = useCallback(() => {
    if (unreadTimer.current != null) return;
    unreadTimer.current = window.setTimeout(() => {
      unreadTimer.current = null;
      api
        .folderUnreadCounts()
        .then((pairs) => {
          const next: Record<number, number> = {};
          for (const [folderId, count] of pairs) next[folderId] = count;
          setUnreadByFolder(next);
        })
        .catch(() => {});
    }, 400);
  }, []);

  const bootstrap = useCallback(async () => {
    try {
      // 地址簿和邮件无关：读不到也只是没有补全，不该拦住启动。
      api
        .addressBookList()
        .then(setContacts)
        .catch(() => {});
      const accs = await api.listAccounts();
      setAccounts(accs);
      if (accs.length === 0) {
        setSetupOpen(true);
        setStatus('请先添加邮箱账户');
        return;
      }
      const fs = await refreshFolders();
      refreshUnread();
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
  }, [loadRows, refreshFolders, refreshUnread]);

  useEffect(() => {
    // 窗口在配置里是隐藏的：等第一帧画好再显示，避免启动时先闪一块空白黑窗。
    window.requestAnimationFrame(() => {
      void api.showMainWindow().catch(() => {});
    });
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
        refreshUnread();
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

  /**
   * Open a message: mark it selected and load its body.
   *
   * Bodies can come from the server, which takes seconds on a slow link. Two
   * things keep the pane honest while that happens:
   *
   * - the body of the previously selected message is dropped immediately, so
   *   the pane shows 「正在载入邮件…」 instead of the mail before it;
   * - every request carries a token, and a response for a message the user
   *   has since clicked away from is ignored (clicking fast used to let a slow
   *   first request overwrite the newer mail's body).
   */
  const openMessage = useCallback(async (id: number) => {
    const switching = selectedRef.current !== id;
    // Keep the ref in step with the state so the token check below is exact
    // even before React re-renders.
    selectedRef.current = id;
    setSelectedId(id);
    const token = bodyGate.current.start();
    // 最近读过的邮件直接从缓存显示：点回去立刻出现，不用等 IPC + 解析。
    const cached = bodyCache.current.get(id);
    if (cached) {
      setBody(cached);
      if (bodyCache.current.isFresh(id)) return;
    } else if (switching) {
      setBody(null);
    }
    try {
      const detail = await api.getBody(id);
      if (!bodyGate.current.current(token)) return;
      bodyCache.current.set(id, detail);
      setBody(detail);
    } catch (e) {
      if (bodyGate.current.current(token) && !cached) setStatus(String(e));
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
    await reloadCurrent();
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
    refreshUnread();
  }, [act, openMessage, showToast, reloadCurrent, refreshFolders, refreshUnread]);

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
      bodyCache.current.patch(id, { isRead: read });
      refreshUnread();
    },
    [act, refreshUnread],
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

  const startNew = useCallback(() => {
    if (accountsRef.current.length === 0) {
      showToast('请先添加账户');
      setSetupOpen(true);
      return;
    }
    setCompose({ mode: 'new', replyAll: false, inline: false, original: null });
  }, [showToast]);

  /** 点邮件里的地址：用应用自己的写邮件窗口，而不是甩给系统默认程序。 */
  const startNewTo = useCallback(
    (email: string) => {
      if (accountsRef.current.length === 0) {
        showToast('请先添加账户');
        setSetupOpen(true);
        return;
      }
      setCompose({
        mode: 'new',
        replyAll: false,
        inline: false,
        original: null,
        initialTo: email,
      });
    },
    [showToast],
  );

  /** 把邮件里的地址加进地址簿（同名地址不重复添加）。 */
  const addToBook = useCallback(
    async (address: EngineAddress) => {
      const email = address.email?.trim();
      if (!email) return;
      try {
        const list = await api.addressBookSave({
          id: '',
          name: address.name ?? '',
          email,
          extra: {},
        });
        setContacts(list);
        showToast(
          `已加入地址簿：${address.name ? `${address.name} <${email}>` : email}`,
        );
      } catch (e) {
        setStatus(String(e));
      }
    },
    [showToast],
  );

  const reply = useCallback(
    (all = false) => {
      if (!body) {
        showToast('请先选择一封邮件');
        return;
      }
      setCompose({ mode: 'reply', replyAll: all, inline: true, original: body });
    },
    [body, showToast],
  );

  const forward = useCallback(() => {
    if (!body) {
      showToast('请先选择一封邮件');
      return;
    }
    setCompose({ mode: 'forward', replyAll: false, inline: true, original: body });
  }, [body, showToast]);

  /** 归档：从当前文件夹移到账户的归档文件夹（引擎 `archive` 动作）。 */
  const archiveSelected = useCallback(async () => {
    const id = selectedRef.current;
    if (id == null) return;
    try {
      await act('archive');
    } catch (e) {
      setStatus(String(e));
      showToast(`无法归档：${String(e)}`);
      return;
    }
    const current = rowsRef.current;
    const idx = current.findIndex((m) => m.id === id);
    const next = current[idx + 1] ?? current[idx - 1] ?? null;
    if (next) {
      setSelectedId(next.id);
      openMessage(next.id);
    } else {
      setSelectedId(null);
      setBody(null);
    }
    await reloadCurrent();
    await refreshFolders();
    showToast('已归档');
  }, [act, openMessage, reloadCurrent, refreshFolders, showToast]);

  const syncNow = useCallback(async () => {
    setStatus('正在同步…');
    try {
      await api.syncNow();
    } catch (e) {
      setStatus(String(e));
    }
  }, []);

  /** 当前文件夹能整个清空吗：废纸篓和垃圾邮件。 */
  const activeFolder = useMemo(
    () => folders.find((folder) => folder.id === folderId) ?? null,
    [folders, folderId],
  );
  const canEmpty = activeFolder?.role === 'trash' || activeFolder?.role === 'spam';

  /**
   * 清空废纸篓 / 垃圾邮件。
   *
   * 废纸篓用引擎的 `empty_trash`：服务端自己枚举整个废件夹（包括本地还没下载的
   * 邮件）。垃圾邮件没有对应的引擎动作，改为把本地已知的邮件逐批
   * `delete_permanently`。两者都进引擎的持久队列，由同步在服务端确认。
   */
  const runEmptyFolder = useCallback(async () => {
    const target = emptyConfirm;
    if (!target) return;
    setEmptying(true);
    try {
      if (target.role === 'trash') {
        await api.emptyTrash(target.accountId);
        showToast('已请求清空废纸篓，服务器确认后完成');
      } else {
        const ids: number[] = [];
        let cursor: { date: number; messageId: number } | null = null;
        for (let round = 0; round < 50; round += 1) {
          const page = await api.listMessages(target.id, viewForRole(target.role), 200, cursor);
          ids.push(...page.messages.map((message) => message.id));
          if (!page.nextCursor || page.messages.length === 0) break;
          cursor = page.nextCursor;
        }
        if (ids.length === 0) {
          showToast('这个文件夹已经是空的');
        } else {
          await api.performAction({
            kind: 'delete_permanently',
            target: { messages: ids },
            params: null,
          });
          showToast(`已请求永久删除 ${ids.length} 封邮件`);
        }
      }
      // 清的就是当前文件夹：先把列表清掉，别让人以为没生效。
      if (folderIdRef.current === target.id) {
        setRows([]);
        setSelectedId(null);
        setBody(null);
      }
      await refreshFolders();
      setStatus(`${target.name} 已请求清空`);
    } catch (e) {
      setStatus(String(e));
      showToast(`清空失败：${String(e)}`);
    } finally {
      setEmptying(false);
      setEmptyConfirm(null);
    }
  }, [emptyConfirm, showToast, refreshFolders]);

  /** 右键：文件夹菜单（清空 / 全部已读 / 同步）。 */
  const markFolderRead = useCallback(
    async (folder: EngineFolder) => {
      try {
        await api.markFolderRead(folder.id, viewForRole(folder.role));
        if (folderIdRef.current === folder.id) {
          await loadRows(folder.id, viewRef.current);
        }
        showToast(`已将「${folder.displayName}」全部标为已读`);
      } catch (e) {
        setStatus(String(e));
        showToast(`操作失败：${String(e)}`);
      }
    },
    [loadRows, showToast],
  );

  const openFolderMenu = useCallback((folder: EngineFolder, event: MouseEvent) => {
    setMenu({ x: event.clientX, y: event.clientY, target: { kind: 'folder', folder } });
  }, []);

  /**
   * 右键邮件：先把这一封选中（同步改 ref，菜单动作立刻作用在它身上），
   * 再弹出菜单。`isRead` 一起记下来，菜单文案不会因为正文还没加载而用错。
   */
  const openMessageMenu = useCallback(
    (id: number, isRead: boolean, event: MouseEvent) => {
      selectedRef.current = id;
      void openMessage(id);
      setMenu({ x: event.clientX, y: event.clientY, target: { kind: 'message', isRead } });
    },
    [openMessage],
  );

  const menuItems = useMemo<ContextMenuItem[]>(() => {
    if (!menu) return [];
    if (menu.target.kind === 'folder') {
      const folder = menu.target.folder;
      const items: ContextMenuItem[] = [];
      if (folder.role === 'trash' || folder.role === 'spam') {
        items.push({
          label: '清空文件夹',
          danger: true,
          onSelect: () =>
            setEmptyConfirm({
              id: folder.id,
              name: folder.displayName,
              role: folder.role ?? '',
              accountId: folder.accountId,
            }),
        });
      }
      items.push(
        { label: '全部标为已读', onSelect: () => void markFolderRead(folder) },
        { label: '同步', onSelect: () => void syncNow() },
      );
      return items;
    }
    const { isRead } = menu.target;
    return [
      {
        label: isRead ? '标为未读' : '标为已读',
        onSelect: () => void setRead(!isRead),
      },
      { label: '归档', onSelect: () => void archiveSelected() },
      { label: '删除', shortcut: 'Delete', danger: true, onSelect: () => void deleteSelected() },
    ];
  }, [menu, markFolderRead, syncNow, setRead, archiveSelected, deleteSelected]);

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
      } else if (mod && e.shiftKey && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        reply(true);
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
    const orphans: EngineFolder[] = [];
    for (const f of folders) {
      const group = byAccount.get(f.accountId);
      if (group) group.folders.push(f);
      else orphans.push(f);
    }
    const groups = [...byAccount.values()];
    if (orphans.length > 0) {
      if (accounts.length === 1) {
        // 只有一个真实账户（本机导入的邮件就是同一个邮箱的旧邮件）：并进这一组，
        // 免得看起来像多了一个邮箱。同名/同角色的文件夹不再重复列出——它们的
        // 邮件已经并进对应视图里了。
        const group = groups[0];
        const paths = new Set(group.folders.map((folder) => folder.path.toLowerCase()));
        const roles = new Set(
          group.folders.map((folder) => folder.role).filter((role): role is string => Boolean(role)),
        );
        for (const folder of orphans) {
          if (paths.has(folder.path.toLowerCase())) continue;
          if (folder.role && roles.has(folder.role)) continue;
          group.folders.push(folder);
        }
      } else {
        groups.push({ account: undefined, folders: orphans });
      }
    }
    return groups;
  }, [accounts, folders]);

  /** The open message's account address, left out of a reply-all. */
  const ownAddress = useMemo(() => {
    const accountId = compose?.original?.accountId ?? body?.accountId;
    return accounts.find((account) => account.id === accountId)?.email ?? null;
  }, [accounts, body?.accountId, compose?.original?.accountId]);

  /** 本机邮件账户（引擎的账户列表不包含它）：导入的邮件都在这儿。 */
  const localAccountIds = useMemo(() => {
    const known = new Set(accounts.map((account) => account.id));
    return [...new Set(folders.map((folder) => folder.accountId))].filter((id) => !known.has(id));
  }, [accounts, folders]);

  /**
   * 只有一个真实账户时，把本机导入的邮件并进同一个视图：一个收件箱里既有
   * 服务器上的新邮件，也有从 Outlook 导进来的旧邮件（去重已在导入时做过）。
   */
  const mergedFor = useCallback(
    (folder: EngineFolder) => {
      if (accounts.length !== 1 || localAccountIds.length === 0) return null;
      if (folder.accountId !== accounts[0].id) return null;
      const view = viewForRole(folder.role);
      if (!['inbox', 'sent', 'drafts', 'done', 'trash', 'spam'].includes(view)) return null;
      return { accountIds: [accounts[0].id, ...localAccountIds], view };
    },
    [accounts, localAccountIds],
  );

  /** 与本机副本按路径对应的那个文件夹（导入的旧邮件就在里面）。 */
  const mirrorOf = useCallback(
    (folder: EngineFolder) => {
      if (accounts.length !== 1 || localAccountIds.length === 0) return null;
      if (localAccountIds.includes(folder.accountId)) return null;
      const path = folder.path.toLowerCase();
      return (
        folders.find(
          (candidate) =>
            localAccountIds.includes(candidate.accountId) &&
            candidate.path.toLowerCase() === path,
        ) ?? null
      );
    },
    [accounts.length, localAccountIds, folders],
  );

  /**
   * 多账户时在文件夹树顶部放一个合并收件箱：引擎按 view 列所有账户的
   * 收件箱（不传 accountId），删除/归档/回复仍按每封邮件自己的账户走。
   */
  const unifiedInbox = useMemo(() => {
    if (accounts.length < 2) return null;
    return {
      label: '所有收件箱',
      active: folderId === null,
      onSelect: () => {
        if (search) clearSearch();
        mergedRef.current = null;
        setMerged(null);
        pairRef.current = null;
        setPaired(false);
        setFolderId(null);
        void loadRows(null, 'inbox');
      },
    };
  }, [accounts.length, folderId, search, clearSearch, loadRows]);

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-logo" aria-hidden="true">F</span>
          FirthMail
        </div>
        <div className="search-box">
          <input
            className="search"
            placeholder="搜索邮件（Enter 确认；支持 from:/to: 语法）"
            aria-label="搜索邮件"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                void runSearch(searchInput);
              } else if (e.key === 'Escape' && (searchInput || search)) {
                clearSearch();
              }
            }}
          />
          {(searchInput || search) && (
            <button
              className="search-clear"
              title="清除搜索（Esc）"
              aria-label="清除搜索"
              onClick={() => clearSearch()}
            >
              ×
            </button>
          )}
        </div>
      </header>

      <MailToolbar
        hasSelection={selectedId != null && !compose}
        isRead={body?.isRead ?? true}
        canEmpty={canEmpty}
        onNew={startNew}
        onDelete={() => void deleteSelected()}
        onArchive={() => void archiveSelected()}
        onEmpty={() => {
          if (!activeFolder) return;
          setEmptyConfirm({
            id: activeFolder.id,
            name: activeFolder.displayName,
            role: activeFolder.role ?? '',
            accountId: activeFolder.accountId,
          });
        }}
        onReply={() => reply()}
        onReplyAll={() => reply(true)}
        onForward={forward}
        onToggleRead={() => {
          if (body) void setRead(toggledReadState(body.isRead));
        }}
        onSync={() => void syncNow()}
        onImport={() => setImportOpen(true)}
        onAddressBook={() => setAddressBookOpen(true)}
        onAccounts={() => setSetupOpen(true)}
      />

      <div className="app-body">
        <FolderTree
          groups={grouped}
          activeId={folderId}
          unified={unifiedInbox}
          unread={unreadByFolder}
          onContextMenu={openFolderMenu}
          onSelect={(folder) => {
            if (search) clearSearch();
            const nextMerged = mergedFor(folder);
            mergedRef.current = nextMerged;
            setMerged(nextMerged);
            const mirror = nextMerged ? null : mirrorOf(folder);
            pairRef.current = mirror
              ? { folders: [folder.id, mirror.id], cursors: [null, null], buffers: [[], []], done: [false, false] }
              : null;
            setPaired(mirror != null);
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
          {(merged || paired) && (
            <div className="merge-banner" role="status">
              {merged
                ? '已合并显示本机导入的邮件（同一邮箱）'
                : '已合并显示这个文件夹的本机副本'}
            </div>
          )}
          <MessageList
            rows={rows}
            selectedId={selectedId}
            loadingMore={loadingMore}
            onLoadMore={() => void loadMore()}
            onSelect={(id) => openMessage(id)}
            onContextMenu={(id, event) => {
              const row = rows.find((message) => message.id === id);
              openMessageMenu(id, row?.isRead ?? false, event);
            }}
          />
        </div>
        {/* 阅读区：内嵌回复直接盖在邮件上（邮件仍留在下面，切回不丢草稿）。 */}
        <div className="reading-slot">
          <ReadingPane
            message={body}
            selected={selectedId}
            onReply={() => reply()}
            onReplyAll={() => reply(true)}
            onForward={forward}
            onDelete={() => void deleteSelected()}
            onArchive={() => void archiveSelected()}
            onToggleRead={() => {
              if (body) void setRead(toggledReadState(body.isRead));
            }}
            onContextMenu={
              body ? (event) => openMessageMenu(body.id, body.isRead, event) : undefined
            }
            onCopied={(text) => showToast(`已复制：${text}`)}
            onComposeAddress={startNewTo}
            onAddToBook={(address) => void addToBook(address)}
          />
          {compose && (
            <ComposeForm
              // 换了要回的信（或新邮件）就换一份草稿，别留着上一封的内容。
              key={`${compose.mode}-${compose.original?.id ?? 'new'}-${compose.initialTo ?? ''}`}
              mode={compose.mode}
              replyAll={compose.replyAll}
              original={compose.original}
              accountId={compose.original?.accountId ?? accounts[0]?.id ?? null}
              ownAddress={ownAddress}
              initialToAddress={compose.initialTo}
              contacts={contacts}
              onDiscard={() => setCompose(null)}
              onSent={(text) => {
                setCompose(null);
                showToast(text);
              }}
              onPopOut={
                compose.inline
                  ? () =>
                      setCompose((current) =>
                        current ? { ...current, inline: false } : current,
                      )
                  : undefined
              }
            />
          )}
        </div>
      </div>

      <footer className="app-footer">
        <span>{status}</span>
        <span className="footer-right">
          <em className={eventCount > 0 ? 'events-ok' : 'events-none'}>
            引擎事件 ×{eventCount}
            {backendEvents != null && `｜后端 ×${backendEvents}`}
          </em>
          <span className="kbd-hint">
            Delete 删除 · ↑↓ 选择 · Ctrl+Q 已读 · Ctrl+U 未读 · Ctrl+R 回复 · Ctrl+Shift+R 全部回复 · Ctrl+F 转发 · 停留 3 秒自动已读
          </span>
        </span>
      </footer>

      {toast && <div className="toast" role="status">{toast}</div>}
      {menu && menuItems.length > 0 && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      )}
      {emptyConfirm && (
        <ConfirmDialog
          title={`清空「${emptyConfirm.name}」`}
          message={
            emptyConfirm.role === 'trash'
              ? '这个账户废纸篓里的邮件将被永久删除，无法恢复。'
              : '这个文件夹里的邮件将被永久删除，无法恢复。'
          }
          confirmLabel="清空"
          danger
          busy={emptying}
          onCancel={() => setEmptyConfirm(null)}
          onConfirm={() => void runEmptyFolder()}
        />
      )}
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
      {addressBookOpen && (
        <AddressBook
          contacts={contacts}
          onClose={() => setAddressBookOpen(false)}
          onChanged={setContacts}
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
    </div>
  );
}
