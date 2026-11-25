import { useEffect, useRef } from 'react';
import type { EngineMessage } from '../types';

function formatListTime(epoch: number): string {
  const d = new Date(epoch);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

interface Props {
  rows: EngineMessage[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onContextMenu?: (id: number, event: MouseEvent) => void;
}

export default function MessageList({ rows, selectedId, onSelect, onContextMenu }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const selectedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedId]);

  useEffect(() => {
    listRef.current?.focus();
  }, []);

  return (
    <div className="message-list" ref={listRef} tabIndex={0} role="listbox" aria-label="邮件列表">
      {rows.length === 0 && <div className="list-empty">此文件夹中没有邮件</div>}
      {rows.map((m) => (
        <div
          key={m.id}
          ref={m.id === selectedId ? selectedRef : undefined}
          role="option"
          aria-selected={m.id === selectedId}
          className={`message-row ${m.id === selectedId ? 'selected' : ''} ${m.isRead ? '' : 'unread'}`}
          onClick={() => onSelect(m.id)}
          onContextMenu={(event) => {
            event.preventDefault();
            onContextMenu?.(m.id, event.nativeEvent);
          }}
        >
          <div className="row-main">
            <div className="row-from">
              {!m.isRead && <span className="unread-dot" aria-label="未读" />}
              <span className="from-text">
                {m.isOutgoing ? `收件人：${m.to.map((t) => t.name ?? t.email).join('、')}` : m.from.name ?? m.from.email ?? '(无名发件人)'}
              </span>
              {m.isStarred && <span className="flag" title="已标记">🚩</span>}
              {m.hasAttachments && <span className="attach" title="附件">📎</span>}
            </div>
            <div className="row-subject">{m.subject || '(无主题)'}</div>
          </div>
          <div className="row-side">
            <div className="row-time">{formatListTime(m.date)}</div>
            <div className="row-preview">{m.snippet}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
