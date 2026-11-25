import { useEffect, useRef, useState } from 'react';
import type { EngineMessage } from '../types';

/** Every row is one height, which is what makes a list of 30k mail cheap. */
const ROW_HEIGHT = 64;
/** Rows rendered beyond the viewport, so scrolling doesn't flash. */
const OVERSCAN = 6;

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
  /** More pages are on their way from the engine. */
  loadingMore?: boolean;
  /** The list scrolled near its end: ask for the next page. */
  onLoadMore?: () => void;
}

/**
 * 消息列表：只渲染视口内几十行（虚拟滚动），滚到接近底部时向引擎要下一页。
 * 3 万封邮件也是这个开销——DOM 里永远只有几十个节点。
 */
export default function MessageList({
  rows,
  selectedId,
  onSelect,
  onContextMenu,
  loadingMore = false,
  onLoadMore,
}: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);

  useEffect(() => {
    const element = listRef.current;
    if (!element) return;
    setViewportHeight(element.clientHeight);
    const observer = new ResizeObserver(() => setViewportHeight(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    listRef.current?.focus();
  }, []);

  // 键盘/事件选中的邮件可能在视口外：直接把它滚进来（虚拟列表里没有节点可 scrollIntoView）。
  useEffect(() => {
    const element = listRef.current;
    if (!element || selectedId == null) return;
    const index = rows.findIndex((row) => row.id === selectedId);
    if (index < 0) return;
    const top = index * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;
    if (top < element.scrollTop) {
      element.scrollTop = top;
    } else if (bottom > element.scrollTop + element.clientHeight) {
      element.scrollTop = bottom - element.clientHeight;
    }
  }, [selectedId, rows]);

  const onScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget;
    setScrollTop(element.scrollTop);
    if (!onLoadMore || loadingMore) return;
    // 快到底了：提前一点取下一页，滚动不中断。
    if (element.scrollHeight - element.scrollTop - element.clientHeight < ROW_HEIGHT * 8) {
      onLoadMore();
    }
  };

  const total = rows.length;
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(total, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);

  return (
    <div
      className="message-list"
      ref={listRef}
      tabIndex={0}
      role="listbox"
      aria-label="邮件列表"
      onScroll={onScroll}
    >
      {total === 0 && <div className="list-empty">此文件夹中没有邮件</div>}
      <div className="message-list-spacer" style={{ height: total * ROW_HEIGHT }}>
        <div className="message-list-window" style={{ transform: `translateY(${start * ROW_HEIGHT}px)` }}>
          {rows.slice(start, end).map((m) => (
            <div
              key={m.id}
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
                    {m.isOutgoing
                      ? `收件人：${m.to.map((t) => t.name ?? t.email).join('、')}`
                      : m.from.name ?? m.from.email ?? '(无名发件人)'}
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
      </div>
      {loadingMore && (
        <div className="list-loading" role="status">
          正在加载更多邮件…
        </div>
      )}
    </div>
  );
}
