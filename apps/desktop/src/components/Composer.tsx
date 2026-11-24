import { useState } from 'react';
import { api } from '../api';
import type { EngineMessageDetail } from '../types';

export type ComposeMode = 'reply' | 'forward' | 'new';

interface Props {
  mode: ComposeMode;
  /** The message being answered or forwarded; null for new mail. */
  original: EngineMessageDetail | null;
  accountId: number | null;
  onClose: () => void;
  onSent: (text: string) => void;
}

function quoteBody(original: EngineMessageDetail | null): string {
  if (!original) return '';
  const from = original.from.name ?? original.from.email ?? '(无名发件人)';
  const when = new Date(original.date).toLocaleString('zh-CN');
  const lines = (original.textBody ?? '')
    .split(/\r?\n/)
    .map((line) => (line ? `> ${line}` : '>'));
  return `\n\n在 ${when}，${from} 写道：\n${lines.join('\n')}`;
}

/** 回复 / 转发 / 新邮件。保存为引擎草稿后进入发送队列（带撤销延迟）。 */
export default function Composer({ mode, original, accountId, onClose, onSent }: Props) {
  const [to, setTo] = useState(mode === 'reply' && original ? original.from.email ?? '' : '');
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState(() => {
    if (!original) return '';
    const prefix = mode === 'forward' ? 'FW: ' : 'RE: ';
    return original.subject.startsWith(prefix) ? original.subject : prefix + original.subject;
  });
  const [body, setBody] = useState(quoteBody(original));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const title = mode === 'reply' ? '回复' : mode === 'forward' ? '转发' : '新邮件';

  const send = async () => {
    setError(null);
    if (accountId == null) {
      setError('没有可发件的账户');
      return;
    }
    const recipients = to
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
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
        to: recipients.map((email) => ({ name: null, email })),
        cc: cc
          .split(/[,;\s]+/)
          .map((s) => s.trim())
          .filter(Boolean)
          .map((email) => ({ name: null, email })),
        bcc: [],
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

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal modal-compose">
        <h1>{title}</h1>
        <label className="root-path">
          收件人
          <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="a@x.com, b@y.com" autoFocus />
        </label>
        <label className="root-path">
          抄送
          <input value={cc} onChange={(e) => setCc(e.target.value)} />
        </label>
        <label className="root-path">
          主题
          <input value={subject} onChange={(e) => setSubject(e.target.value)} />
        </label>
        <label className="root-path">
          正文
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={12}
            spellCheck={false}
          />
        </label>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="primary" disabled={busy} onClick={() => void send()}>
            {busy ? '发送中…' : '发送'}
          </button>
        </div>
      </div>
    </div>
  );
}
