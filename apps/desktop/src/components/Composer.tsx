import { useState } from 'react';
import { api } from '../api';
import type { EngineMessageDetail } from '../types';

export type ComposeMode = 'reply' | 'forward' | 'new';

/** Where a reply starts: the sender, or everyone the original reached. */
function initialTo(
  mode: ComposeMode,
  original: EngineMessageDetail | null,
  prefilled?: string,
): string {
  if (mode === 'new') return prefilled?.trim() ?? '';
  return mode === 'reply' && original ? (original.from.email ?? '') : '';
}

function initialCc(
  mode: ComposeMode,
  replyAll: boolean,
  original: EngineMessageDetail | null,
  ownAddress: string | null,
): string {
  if (mode !== 'reply' || !replyAll || !original) return '';
  const skip = new Set(
    [original.from.email, ownAddress ?? ''].map((address) => address.toLowerCase()).filter(Boolean),
  );
  const addresses = [...original.to, ...original.cc]
    .map((entry) => entry.email)
    .filter((email) => email && !skip.has(email.toLowerCase()));
  return [...new Set(addresses)].join(', ');
}

function quotes(original: EngineMessageDetail | null): string {
  if (!original) return '';
  const from = original.from.name ?? original.from.email ?? '(无名发件人)';
  const when = new Date(original.date).toLocaleString('zh-CN');
  const lines = (original.textBody ?? '')
    .split(/\r?\n/)
    .map((line) => (line ? `> ${line}` : '>'));
  return `\n\n在 ${when}，${from} 写道：\n${lines.join('\n')}`;
}

const subjectOf = (mode: ComposeMode, original: EngineMessageDetail | null): string => {
  if (!original) return '';
  const prefix = mode === 'forward' ? 'FW: ' : 'RE: ';
  return original.subject.startsWith(prefix) ? original.subject : prefix + original.subject;
};

interface FormProps {
  mode: ComposeMode;
  /** Reply to everyone the original reached, not just its sender. */
  replyAll?: boolean;
  original: EngineMessageDetail | null;
  accountId: number | null;
  /** This account's own address, left out of a reply-all. */
  ownAddress?: string | null;
  /** 新邮件的初始收件人（点邮件地址时带上）。 */
  initialToAddress?: string;
  onDiscard: () => void;
  onSent: (text: string) => void;
  /** Inline replies can pop out into their own window; absent when already one. */
  onPopOut?: () => void;
}

/**
 * 回复 / 全部回复 / 转发 / 新邮件。保存为引擎草稿后进入发送队列
 * （带撤销延迟）。内嵌在阅读窗格里时由 [`ComposeForm`] 直接渲染，
 * 「弹出」切到独立窗口。
 */
export function ComposeForm({
  mode,
  replyAll = false,
  original,
  accountId,
  ownAddress = null,
  initialToAddress,
  onDiscard,
  onSent,
  onPopOut,
}: FormProps) {
  const [to, setTo] = useState(() => initialTo(mode, original, initialToAddress));
  const [cc, setCc] = useState(() => initialCc(mode, replyAll, original, ownAddress));
  const [bcc, setBcc] = useState('');
  const [subject, setSubject] = useState(() => subjectOf(mode, original));
  const [body, setBody] = useState(() => quotes(original));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const title =
    mode === 'reply' ? (replyAll ? '全部回复' : '回复') : mode === 'forward' ? '转发' : '新邮件';
  const inline = onPopOut != null;

  const addresses = (value: string) =>
    value
      .split(/[,;\s]+/)
      .map((part) => part.trim())
      .filter(Boolean)
      .map((email) => ({ name: null, email }));

  const send = async () => {
    setError(null);
    if (accountId == null) {
      setError('没有可发件的账户');
      return;
    }
    const recipients = addresses(to);
    if (recipients.length === 0) {
      setError('请至少填写一个收件人');
      return;
    }
    setBusy(true);
    try {
      const draftId = await api.saveDraft({
        draftId: null,
        accountId,
        from: null,
        to: recipients,
        cc: addresses(cc),
        bcc: addresses(bcc),
        subject: subject.trim(),
        bodyText: body,
        bodyHtml: null,
        mode,
        inReplyToMessageId: mode !== 'new' && original ? original.id : null,
        inReplyToHeader: null,
        attachments: [],
        requestReadReceipt: false,
        importance: 'normal',
      });
      await api.queueSend(draftId);
      onSent('邮件已进入发送队列（状态栏可看进度，引擎带撤销延迟）');
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const content = (
    <>
      <div className="composer-head">
        <button className="primary" disabled={busy} onClick={() => void send()}>
          {busy ? '发送中…' : '发送'}
        </button>
        <span className="composer-title">{title}</span>
        <span className="toolbar-spacer" />
        {inline && (
          <button className="link" onClick={onPopOut} title="在独立窗口中撰写">
            弹出
          </button>
        )}
        <button className="link" onClick={onDiscard} disabled={busy}>
          放弃
        </button>
      </div>
      <div className="composer-fields">
        <label>
          <span>收件人</span>
          <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="a@x.com, b@y.com" autoFocus />
        </label>
        <label>
          <span>抄送</span>
          <input value={cc} onChange={(e) => setCc(e.target.value)} />
        </label>
        <label>
          <span>密件抄送</span>
          <input value={bcc} onChange={(e) => setBcc(e.target.value)} />
        </label>
        <label>
          <span>主题</span>
          <input value={subject} onChange={(e) => setSubject(e.target.value)} />
        </label>
      </div>
      {error && <div className="form-error">{error}</div>}
      <textarea
        className="composer-body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        spellCheck={false}
      />
    </>
  );

  if (inline) {
    return (
      <section className="composer-inline" aria-label={title}>
        {content}
      </section>
    );
  }
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal modal-compose">{content}</div>
    </div>
  );
}
