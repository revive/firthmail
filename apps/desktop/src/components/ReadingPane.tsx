import type { EngineMessageDetail } from '../types';
import { sanitizeMailHtml } from '../sanitize';

interface Props {
  /** The opened message's body, from the engine's cache or the server. */
  message: EngineMessageDetail | null;
  /** Selection id, so actions work before the body arrives. */
  selected: number | null;
  onReply: () => void;
  onForward: () => void;
  onDelete: () => void;
  onToggleRead: () => void;
}

const initials = (m: EngineMessageDetail) =>
  (m.from.name ?? m.from.email ?? '?').slice(0, 1).toUpperCase();

export default function ReadingPane({ message, selected, onReply, onForward, onDelete, onToggleRead }: Props) {
  if (!message) {
    return (
      <section className="reading-pane empty" aria-label="阅读窗格">
        <div className="reading-placeholder">{selected != null ? '正在载入邮件…' : '选择一封邮件进行阅读'}</div>
      </section>
    );
  }
  const date = new Date(message.date);
  return (
    <section className="reading-pane" aria-label="阅读窗格">
      <div className="reading-toolbar">
        <button onClick={onReply} title="回复 (Ctrl+R)">↩ 回复</button>
        <button onClick={onForward} title="转发 (Ctrl+F)">↪ 转发</button>
        <button onClick={onDelete} title="删除 (Delete)">🗑 删除</button>
        <button onClick={onToggleRead} title="切换已读 (Ctrl+Q / Ctrl+U)">
          {message.isRead ? '📨 标为未读' : '📌 标为已读'}
        </button>
      </div>
      <div className="reading-header">
        <h1 className="reading-subject">{message.subject || '(无主题)'}</h1>
        <div className="reading-meta">
          <span className="avatar" aria-hidden="true">{initials(message)}</span>
          <div className="meta-text">
            <div className="meta-from">
              {message.from.name ?? message.from.email ?? '(无名发件人)'}
              <span className="meta-address"> &lt;{message.from.email ?? ''}&gt;</span>
            </div>
            <div className="meta-to">
              收件人：{message.to.map((t) => t.name ?? t.email).join('、')}
              {message.cc.length > 0 && `；抄送：${message.cc.map((t) => t.name ?? t.email).join('、')}`}
            </div>
          </div>
          <div className="meta-date">
            {date.toLocaleString('zh-CN', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </div>
        </div>
      </div>
      {message.attachments.filter((a) => !a.isInline).length > 0 && (
        <div className="attachments">
          {message.attachments
            .filter((a) => !a.isInline)
            .map((a) => (
              <span key={a.id} className="attachment-chip" title={a.filename ?? ''}>
                📎 {a.filename ?? '附件'}
                {a.size != null && <em>{Math.max(1, Math.round(a.size / 1024))} KB</em>}
              </span>
            ))}
        </div>
      )}
      {/*
        邮件 HTML 在 sandbox iframe 里渲染：里面自带的 CSS（比如
        body { font-size: 20px }）再也无法逃出去改整个应用的字体——
        这是网页邮箱的标准做法。sandbox="" 同时禁掉脚本、表单与跳转。
        sanitizeMailHtml 仍先把巨型内联图换成占位，防渲染器 OOM。
      */}
      <div className="reading-body-frame">
        <iframe
          sandbox=""
          title="邮件正文"
          srcDoc={
            message.htmlBody
              ? sanitizeMailHtml(message.htmlBody)
              : `<pre style="white-space:pre-wrap;font:inherit;margin:16px 24px;">${(message.textBody ?? '')
                  .replace(/&/g, '&amp;')
                  .replace(/</g, '&lt;')
                  .replace(/>/g, '&gt;')}</pre>`
          }
        />
      </div>
    </section>
  );
}
