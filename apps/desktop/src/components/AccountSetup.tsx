import { useEffect, useState } from 'react';
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

/**
 * 添加账户。IMAP/POP3 走密码；Outlook.com / Microsoft 365 微软已关闭密码
 * 登录，只能走 OAuth：填一次 Azure 应用的客户端 ID，然后在浏览器里登录。
 */
export default function AccountSetup({ onClose, onAdded }: Props) {
  const [form, setForm] = useState<AddAccountInput>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msClientId, setMsClientId] = useState('');
  const [oauthBusy, setOauthBusy] = useState(false);
  const [oauthNote, setOauthNote] = useState<string | null>(null);

  useEffect(() => {
    api
      .oauthClientId()
      .then(setMsClientId)
      .catch(() => {
        /* 读不到就留空，第一次登录前填上即可 */
      });
  }, []);

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

  const saveMsClientId = async (): Promise<boolean> => {
    try {
      await api.setOauthClientId(msClientId.trim());
      return true;
    } catch (e) {
      setOauthNote(String(e));
      return false;
    }
  };

  const loginMicrosoft = async () => {
    setOauthNote(null);
    setOauthBusy(true);
    try {
      if (msClientId.trim()) {
        if (!(await saveMsClientId())) return;
      }
      setOauthNote('请在浏览器中完成 Microsoft 登录（最多 15 分钟）…');
      await api.startMicrosoftLogin();
      onAdded();
    } catch (e) {
      setOauthNote(String(e));
    } finally {
      setOauthBusy(false);
    }
  };

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
      <div className="modal modal-setup">
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

        <section className="oauth-section">
          <h2>Outlook.com / hotmail.com / Microsoft 365</h2>
          <p className="form-note">
            微软已停止这类邮箱的密码登录（IMAP 基本认证），必须用 OAuth。先在 Azure
            门户注册一个应用（「移动和桌面应用程序」平台，重定向 URI 填
            <code> http://localhost</code>），把 Application (client) ID 填到下面，再点登录。
          </p>
          <label className="oauth-id">
            <span>应用（客户端）ID</span>
            <input
              value={msClientId}
              onChange={(e) => setMsClientId(e.target.value)}
              placeholder="00000000-0000-0000-0000-000000000000"
              spellCheck={false}
            />
          </label>
          <div className="oauth-actions">
            <button onClick={() => void saveMsClientId()} disabled={oauthBusy}>
              仅保存 ID
            </button>
            {oauthBusy ? (
              <button onClick={() => void api.cancelOauth()}>取消登录</button>
            ) : (
              <button className="primary" onClick={() => void loginMicrosoft()}>
                用 Microsoft 账户登录
              </button>
            )}
          </div>
          {oauthNote && <div className="form-note oauth-note">{oauthNote}</div>}
        </section>
      </div>
    </div>
  );
}
