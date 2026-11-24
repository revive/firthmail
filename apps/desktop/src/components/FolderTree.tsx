import { useState, type CSSProperties, type ReactNode } from 'react';
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
}

/** 文件夹树：账户分组 + 父子嵌套（默认展开，▸ 可折叠）。 */
export default function FolderTree({ groups, activeId, onSelect }: Props) {
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());

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

  const renderList = (list: EngineFolder[], parentId: number | null, depth: number): ReactNode =>
    list
      .filter((f) => (f.parentId ?? null) === parentId)
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
      {groups.map((group, gi) => (
        <div key={group.account?.id ?? `g${gi}`} className="folder-group">
          <div className="group-title">
            {group.account ? group.account.name ?? group.account.email : '本机邮件'}
          </div>
          {renderList(group.folders, null, 0)}
        </div>
      ))}
    </nav>
  );
}
