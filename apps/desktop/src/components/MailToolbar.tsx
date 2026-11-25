import type { ReactNode } from 'react';

/** Small 16×16 stroke icons: no icon font, no external assets. */
const PATHS: Record<string, ReactNode> = {
  new: (
    <>
      <rect x="2" y="4" width="12" height="9" rx="1" />
      <path d="M2.5 4.5 8 9l5.5-4.5" />
    </>
  ),
  delete: (
    <>
      <path d="M3 4.5h10" />
      <path d="M6.5 4.5V3h3v1.5" />
      <path d="M4.5 4.5l.7 9h5.6l.7-9" />
      <path d="M6.8 7v4M9.2 7v4" />
    </>
  ),
  archive: (
    <>
      <rect x="2" y="3.5" width="12" height="3" rx=".5" />
      <path d="M3.2 6.5V13h9.6V6.5" />
      <path d="M8 8v3M6.5 9.5 8 11l1.5-1.5" />
    </>
  ),
  reply: (
    <>
      <path d="M6.5 4 2.5 8l4 4" />
      <path d="M2.5 8H9a4.5 4.5 0 0 1 4.5 4.5V13" />
    </>
  ),
  replyAll: (
    <>
      <path d="M6 4 2 8l4 4" />
      <path d="M2 8h5.5A5 5 0 0 1 12.5 13" />
      <path d="M9 4l3 4-3 4" />
    </>
  ),
  forward: (
    <>
      <path d="M9.5 4l4 4-4 4" />
      <path d="M13.5 8H7A4.5 4.5 0 0 0 2.5 12.5V13" />
    </>
  ),
  read: (
    <>
      <rect x="2" y="4" width="12" height="9" rx="1" />
      <path d="M2.5 4.5 8 9l5.5-4.5" />
      <path d="M5 11.5h6" strokeDasharray="1 1.6" />
    </>
  ),
  sync: (
    <>
      <path d="M13 6.5A5.2 5.2 0 0 0 4 4.2" />
      <path d="M3 10a5.2 5.2 0 0 0 9 1.8" />
      <path d="M4 2v2.5h2.5M12 14v-2.5H9.5" />
    </>
  ),
  empty: (
    <>
      <path d="M3 4.5h10" />
      <path d="M6.5 4.5V3h3v1.5" />
      <path d="M4.5 4.5l.7 9h5.6l.7-9" />
      <path d="M6.2 8.5 9.8 11M9.8 8.5 6.2 11" />
    </>
  ),
  import: (
    <>
      <path d="M8 3v7" />
      <path d="M5.5 7.5 8 10l2.5-2.5" />
      <path d="M3 12.5h10" />
    </>
  ),
  account: (
    <>
      <circle cx="8" cy="6" r="2.4" />
      <path d="M3.5 13a4.7 4.7 0 0 1 9 0" />
    </>
  ),
  more: (
    <>
      <circle cx="3.5" cy="8" r="1" />
      <circle cx="8" cy="8" r="1" />
      <circle cx="12.5" cy="8" r="1" />
    </>
  ),
};

export function Icon({ name }: { name: keyof typeof PATHS | string }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name] ?? null}
    </svg>
  );
}

interface Props {
  /** A message is selected, so mail actions apply. */
  hasSelection: boolean;
  isRead: boolean;
  /** The open folder is Trash or Junk, so it can be emptied. */
  canEmpty: boolean;
  onNew: () => void;
  onDelete: () => void;
  onArchive: () => void;
  onEmpty: () => void;
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  onToggleRead: () => void;
  onSync: () => void;
  onImport: () => void;
  onAccounts: () => void;
}

/** The action bar under the title: only the actions this client actually has. */
export default function MailToolbar({
  hasSelection,
  isRead,
  canEmpty,
  onNew,
  onDelete,
  onArchive,
  onEmpty,
  onReply,
  onReplyAll,
  onForward,
  onToggleRead,
  onSync,
  onImport,
  onAccounts,
}: Props) {
  return (
    <div className="toolbar" role="toolbar" aria-label="邮件操作">
      <button className="toolbar-btn primary" onClick={onNew} title="新邮件">
        <Icon name="new" />
        <span>新建邮件</span>
      </button>
      <span className="toolbar-sep" />
      <button className="toolbar-btn" onClick={onDelete} disabled={!hasSelection} title="删除（Delete）">
        <Icon name="delete" />
        <span>删除</span>
      </button>
      <button className="toolbar-btn" onClick={onArchive} disabled={!hasSelection} title="归档">
        <Icon name="archive" />
        <span>归档</span>
      </button>
      <button
        className="toolbar-btn danger"
        onClick={onEmpty}
        disabled={!canEmpty}
        title="清空当前文件夹（永久删除，不可恢复）"
      >
        <Icon name="empty" />
        <span>清空</span>
      </button>
      <span className="toolbar-sep" />
      <button className="toolbar-btn" onClick={onReply} disabled={!hasSelection} title="回复（Ctrl+R）">
        <Icon name="reply" />
        <span>回复</span>
      </button>
      <button
        className="toolbar-btn"
        onClick={onReplyAll}
        disabled={!hasSelection}
        title="全部回复（Ctrl+Shift+R）"
      >
        <Icon name="replyAll" />
        <span>全部回复</span>
      </button>
      <button className="toolbar-btn" onClick={onForward} disabled={!hasSelection} title="转发（Ctrl+F）">
        <Icon name="forward" />
        <span>转发</span>
      </button>
      <span className="toolbar-sep" />
      <button
        className="toolbar-btn"
        onClick={onToggleRead}
        disabled={!hasSelection}
        title={isRead ? '标为未读（Ctrl+U）' : '标为已读（Ctrl+Q）'}
      >
        <Icon name="read" />
        <span>{isRead ? '标为未读' : '标为已读'}</span>
      </button>
      <button className="toolbar-btn" onClick={onSync} title="立即同步">
        <Icon name="sync" />
        <span>同步</span>
      </button>
      <span className="toolbar-spacer" />
      <button className="toolbar-btn subtle" onClick={onImport} title="从磁盘导入邮件">
        <Icon name="import" />
        <span>导入</span>
      </button>
      <button className="toolbar-btn subtle" onClick={onAccounts} title="账户设置">
        <Icon name="account" />
        <span>账户</span>
      </button>
    </div>
  );
}
