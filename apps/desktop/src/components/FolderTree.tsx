import { useState, type CSSProperties, type ReactNode } from 'react';
import { sortFolders } from '../folders';
import type { EngineAccount, EngineFolder } from '../types';

const ICONS: Record<string, string> = {
  inbox: '📥',
  drafts: '📝',
  sent: '📤',
  outbox: '📬',
  trash: '🗑',
  junk: '🚫',
  spam: '🚫',
  archive: '🗄',
};

export interface FolderGroup {
  account: EngineAccount | undefined;
  folders: EngineFolder[];
}

interface Props {
  groups: FolderGroup[];
  activeId: number | null;
  onSelect: (folder: EngineFolder) => void;
  /** 多账户时顶部的合并收件箱；单账户不显示。 */
  unified?: { label: string; active: boolean; onSelect: () => void } | null;
}

/** 文件夹树：账户分组 + 父子嵌套（默认展开，▸ 可折叠）。 */
export default function FolderTree({ groups, activeId, onSelect, unified = null }: Props) {
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
  const [collapsedAccounts, setCollapsedAccounts] = useState<Set<string>>(() => new Set());

  const toggle = (id: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const toggleAccount = (key: string) => {
    setCollapsedAccounts((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const renderList = (list: EngineFolder[], parentId: number | null, depth: number): ReactNode =>
    sortFolders(list.filter((f) => (f.parentId ?? null) === parentId))
      .map((f) => {
        const children = list.filter((c) => (c.parentId ?? null) === f.id);
        const hasChildren = children.length > 0;
        const isCollapsed = collapsed.has(f.id);
        const indent: CSSProperties = { paddingLeft: 8 + depth * 14 };
        return (
          <div key={f.id} className="folder-row">
            <button
              className={`folder-item ${f.id === activeId ? 'active' : ''}`}
              style={indent}
              onClick={() => f.selectable && onSelect(f)}
              title={f.path}
            >
              {hasChildren ? (
                <span
                  className={`expander ${isCollapsed ? '' : 'open'}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(f.id);
                  }}
                  role="button"
                  aria-label={isCollapsed ? '展开' : '折叠'}
                >
                  ▸
                </span>
              ) : (
                <span className="expander leaf" aria-hidden="true" />
              )}
              <span className="folder-icon">{ICONS[f.role ?? ''] ?? '📁'}</span>
              <span className="folder-name">{f.displayName}</span>
            </button>
            {hasChildren && !isCollapsed && renderList(list, f.id, depth + 1)}
          </div>
        );
      });

  return (
    <nav className="folder-tree" aria-label="邮件文件夹">
      {unified && (
        <div className="folder-group unified">
          <button
            className={`folder-item ${unified.active ? 'active' : ''}`}
            style={{ paddingLeft: 8 }}
            onClick={unified.onSelect}
          >
            <span className="folder-icon">📥</span>
            <span className="folder-name">{unified.label}</span>
          </button>
        </div>
      )}
      {groups.map((group, gi) => {
        const key = String(group.account?.id ?? `g${gi}`);
        const collapsedAccount = collapsedAccounts.has(key);
        const label = group.account
          ? (group.account.displayName ?? group.account.name ?? group.account.email)
          : '本机邮件';
        const email = group.account?.email ?? '';
        return (
          <div key={key} className="folder-group">
            <button
              className="group-title"
              onClick={() => toggleAccount(key)}
              title={email ? `${label} <${email}>` : label}
            >
              <span className={`expander ${collapsedAccount ? '' : 'open'}`} aria-hidden="true">
                ▸
              </span>
              <span className="group-name">{label}</span>
              {email && label !== email && <span className="group-email">{email}</span>}
            </button>
            {!collapsedAccount && renderList(group.folders, null, 0)}
          </div>
        );
      })}
    </nav>
  );
}
