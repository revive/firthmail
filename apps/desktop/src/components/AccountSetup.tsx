import { useState } from 'react';
import { api, type AddAccountInput } from '../api';

interface Props {
  onClose: () => void;
  onAdded: () => void;
}

const EMPTY: AddAccountInput = {
  email: '',
  displayName: null,
  username: '',
  password: '',
  mailProtocol: 'imap',
  incomingHost: '',
  incomingPort: 993,
  smtpHost: '',
  smtpPort: 465,
  connection: { incomingSecurity: 'tls', smtpSecurity: 'tls' },
};

/** 添加 IMAP/POP3 账户。密码进 Windows 凭据管理器。 */
export default function AccountSetup({ onClose, onAdded }: Props) {
  const [form, setForm] = useState<AddAccountInput>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof AddAccountInput>(key: K, value: AddAccountInput[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  /** 常见约定：用户名取邮箱 @ 之前的部分；服务器名常与邮箱域名相同。 */
  const fillDefaults = () =>
    setForm((f) => {
      const domain = f.email.split('@')[1] ?? '';
      return {
        ...f,
        username: f.email.split('@')[0] || f.username,
        incomingHost: f.incomingHost || (domain ? `imap.${domain}` : ''),
        smtpHost: f.smtpHost || (domain ? `smtp.${domain}` : ''),
      };
    });

  const submit = async () => {
    setError(null);
    if (!form.email || !form.username || !form.password || !form.incomingHost) {
      setError('请填写邮箱、用户名、密码和收件服务器');
      return;
    }
    setBusy(true);
    try {
      await api.addAccount(form);
      onAdded();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <h1>添加邮箱账户</h1>
        <div className="form-row">
          <button className="link" onClick={fillDefaults}>按邮箱地址填默认值（imap./smtp. 域名，SSL 993/465）</button>
        </div>
        <div className="form-grid">
          <label className="span-2">
            邮箱地址
            <input value={form.email} onChange={(e) => set('email', e.target.value)} placeholder="you@example.com" />
          </label>
          <label>
            用户名
            <input value={form.username} onChange={(e) => set('username', e.target.value)} placeholder="登录用户名（常为邮箱 @ 之前的部分）" />
          </label>
          <label>
            密码
            <input type="password" value={form.password} onChange={(e) => set('password', e.target.value)} />
          </label>
          <label>
            收件服务器 (IMAP)
            <input value={form.incomingHost} onChange={(e) => set('incomingHost', e.target.value)} />
          </label>
          <label>
            端口
            <input type="number" value={form.incomingPort} onChange={(e) => set('incomingPort', Number(e.target.value))} />
          </label>
          <label>
            发件服务器 (SMTP)
            <input value={form.smtpHost} onChange={(e) => set('smtpHost', e.target.value)} />
          </label>
          <label>
            端口
            <input type="number" value={form.smtpPort} onChange={(e) => set('smtpPort', Number(e.target.value))} />
          </label>
          <label>
            收件加密
            <select
              value={form.connection.incomingSecurity}
              onChange={(e) => set('connection', { ...form.connection, incomingSecurity: e.target.value as 'tls' | 'starttls' | 'none' })}
            >
              <option value="tls">SSL/TLS</option>
              <option value="starttls">STARTTLS</option>
            </select>
          </label>
          <label>
            发件加密
            <select
              value={form.connection.smtpSecurity}
              onChange={(e) => set('connection', { ...form.connection, smtpSecurity: e.target.value as 'tls' | 'starttls' | 'none' })}
            >
              <option value="tls">SSL/TLS</option>
              <option value="starttls">STARTTLS</option>
            </select>
          </label>
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button onClick={onClose}>取消</button>
          <button className="primary" disabled={busy} onClick={() => void submit()}>
            {busy ? '连接中…' : '添加并同步'}
          </button>
        </div>
        <p className="form-note">密码保存在 Windows 凭据管理器；数据存于 %APPDATA%\FirthMail。</p>
      </div>
    </div>
  );
}
