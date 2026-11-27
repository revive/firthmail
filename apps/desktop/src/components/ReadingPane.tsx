import { useEffect, useRef, useState } from 'react';
import { Icon } from './MailToolbar';
import AddressChip from './AddressChip';
import { api } from '../api';
import type { EngineAddress, EngineMessageDetail } from '../types';
import { sanitizeMailHtml } from '../sanitize';

interface Props {
  /** The opened message's body, from the engine's cache or the server. */
  message: EngineMessageDetail | null;
  /** Selection id, so actions work before the body arrives. */
  selected: number | null;
  onReply: () => void;
  onReplyAll: () => void;
  onForward: () => void;
  onDelete: () => void;
  onArchive: () => void;
  onToggleRead: () => void;
  onContextMenu?: (event: MouseEvent) => void;
  /** 复制地址后回显一句（状态栏/吐司）。 */
  onCopied?: (text: string) => void;
  /** 点邮件地址时在应用里写新邮件。 */
  onComposeAddress?: (email: string) => void;
  /** 把地址加进地址簿。 */
  onAddToBook?: (address: EngineAddress) => void;
  /** 附件的保存结果/失败原因。 */
  onNotice?: (text: string) => void;
}

const initials = (m: EngineMessageDetail) =>
  (m.from.name ?? m.from.email ?? '?').slice(0, 1).toUpperCase();

export default function ReadingPane({
  message,
  selected,
  onReply,
  onReplyAll,
  onForward,
  onDelete,
  onArchive,
  onToggleRead,
  onContextMenu,
  onCopied,
  onComposeAddress,
  onAddToBook,
  onNotice,
}: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  /** 正在取/存的附件 id（取附件可能要等服务器）。 */
  const [busyAttachment, setBusyAttachment] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const openAttachment = async (attachmentId: number) => {
    setBusyAttachment(attachmentId);
    try {
      await api.attachmentOpen(attachmentId);
    } catch (error) {
      onNotice?.(`打开附件失败：${String(error)}`);
    } finally {
      setBusyAttachment(null);
    }
  };

  const saveAttachment = async (attachmentId: number, fileName?: string | null) => {
    setBusyAttachment(attachmentId);
    try {
      const saved = await api.attachmentSaveAs(attachmentId, fileName ?? '');
      if (saved) onNotice?.(`附件已保存到 ${saved}`);
    } catch (error) {
      onNotice?.(`保存附件失败：${String(error)}`);
    } finally {
      setBusyAttachment(null);
    }
  };

  // 点空白处收起「⋯」菜单。
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menuOpen]);

  if (!message) {
    return (
      <section className="reading-pane empty" aria-label="阅读窗格">
        <div className="reading-placeholder">{selected != null ? '正在载入邮件…' : '选择一封邮件进行阅读'}</div>
      </section>
    );
  }
  const date = new Date(message.date);
  return (
    <section
      className="reading-pane"
      aria-label="阅读窗格"
      onContextMenu={(event) => {
        if (!onContextMenu) return;
        event.preventDefault();
        onContextMenu(event.nativeEvent);
      }}
    >
      <div className="reading-header">
        <h1 className="reading-subject">{message.subject || '(无主题)'}</h1>
        <div className="reading-meta">
          <span className="avatar" aria-hidden="true">{initials(message)}</span>
          <div className="meta-text">
            <div className="meta-from">
              <AddressChip
                address={message.from}
                showEmail
                onCopied={onCopied}
                onOpen={onComposeAddress}
                onAddToBook={onAddToBook}
              />
            </div>
            <div className="meta-to">
              收件人：
              {message.to.map((to, index) => (
                <span key={`to-${to.email}-${index}`}>
                  {index > 0 && '、'}
                  <AddressChip
                    address={to}
                    onCopied={onCopied}
                    onOpen={onComposeAddress}
                    onAddToBook={onAddToBook}
                  />
                </span>
              ))}
              {message.cc.length > 0 && (
                <>
                  ；抄送：
                  {message.cc.map((cc, index) => (
                    <span key={`cc-${cc.email}-${index}`}>
                      {index > 0 && '、'}
                      <AddressChip
                        address={cc}
                        onCopied={onCopied}
                        onOpen={onComposeAddress}
                        onAddToBook={onAddToBook}
                      />
                    </span>
                  ))}
                </>
              )}
            </div>
          </div>
          <div className="reading-side">
            <div className="reading-actions">
              <button onClick={onReply} title="回复（Ctrl+R）">
                <Icon name="reply" />
                回复
              </button>
              <button onClick={onReplyAll} title="全部回复（Ctrl+Shift+R）">
                <Icon name="replyAll" />
                全部回复
              </button>
              <button onClick={onForward} title="转发（Ctrl+F）">
                <Icon name="forward" />
                转发
              </button>
              <div className="more-wrap" ref={menuRef}>
                <button
                  className="icon-only"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  aria-label="更多操作"
                  onClick={() => setMenuOpen((open) => !open)}
                >
                  <Icon name="more" />
                </button>
                {menuOpen && (
                  <div className="action-menu" role="menu">
                    <button
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        onToggleRead();
                      }}
                    >
                      {message.isRead ? '标为未读' : '标为已读'}
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        onArchive();
                      }}
                    >
                      归档
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => {
                        setMenuOpen(false);
                        onDelete();
                      }}
                    >
                      删除
                    </button>
                  </div>
                )}
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
      </div>
      {message.attachments.filter((a) => !a.isInline).length > 0 && (
        <div className="attachments">
          {message.attachments
            .filter((a) => !a.isInline)
            .map((a) => (
              <span key={a.id} className="attachment-chip" title={a.filename ?? ''}>
                <button
                  className="attachment-open"
                  disabled={busyAttachment === a.id}
                  title="用默认程序打开"
                  onClick={() => void openAttachment(a.id)}
                >
                  📎 {a.filename ?? '附件'}
                  {a.size != null && <em>{Math.max(1, Math.round(a.size / 1024))} KB</em>}
                </button>
                <button
                  className="attachment-save"
                  disabled={busyAttachment === a.id}
                  title="下载（另存为）"
                  onClick={() => void saveAttachment(a.id, a.filename)}
                >
                  {busyAttachment === a.id ? '…' : '⬇'}
                </button>
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
