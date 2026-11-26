import { useState } from 'react';
import { api } from '../api';
import { draftContact, type Contact } from '../addressBook';

interface Props {
  contacts: Contact[];
  onClose: () => void;
  /** 存储侧返回了新的完整列表。 */
  onChanged: (contacts: Contact[]) => void;
}

/** 地址簿：查看、新增、编辑、删除。目前只有名字和地址两个字段。 */
export default function AddressBook({ contacts, onClose, onChanged }: Props) {
  const [draft, setDraft] = useState<Contact>(() => draftContact());
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');

  const reset = () => {
    setDraft(draftContact());
    setEditing(null);
  };

  const save = async () => {
    setError(null);
    if (!draft.email.trim()) {
      setError('请填写邮件地址');
      return;
    }
    setBusy(true);
    try {
      const list = await api.addressBookSave({
        id: editing ?? '',
        name: draft.name,
        email: draft.email,
        extra: draft.extra ?? {},
      });
      onChanged(list);
      reset();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (contact: Contact) => {
    setError(null);
    try {
      const list = await api.addressBookRemove(contact.id);
      onChanged(list);
      if (editing === contact.id) reset();
    } catch (e) {
      setError(String(e));
    }
  };

  const startEdit = (contact: Contact) => {
    setDraft(contact);
    setEditing(contact.id);
    setError(null);
  };

  const visible = contacts.filter((contact) => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return true;
    return (
      contact.name.toLowerCase().includes(needle) ||
      contact.email.toLowerCase().includes(needle)
    );
  });

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="地址簿">
      <div className="modal modal-wide address-book">
        <h1>地址簿</h1>
        <p className="form-note">
          写邮件时输入名字或地址会自动提示；数据存在 %APPDATA%\FirthMail\address-book.json。
        </p>

        <div className="address-book-form">
          <input
            value={draft.name}
            placeholder="名字"
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
          <input
            value={draft.email}
            placeholder="someone@example.com"
            spellCheck={false}
            onChange={(event) => setDraft({ ...draft, email: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void save();
            }}
          />
          <button className="primary" disabled={busy} onClick={() => void save()}>
            {editing ? '保存修改' : '添加'}
          </button>
          {editing && (
            <button onClick={reset} disabled={busy}>
              取消
            </button>
          )}
        </div>
        {error && <div className="form-error">{error}</div>}

        <input
          className="address-book-filter"
          value={filter}
          placeholder={`筛选（共 ${contacts.length} 条）`}
          onChange={(event) => setFilter(event.target.value)}
        />

        <div className="address-book-list">
          {visible.length === 0 && <div className="list-empty">还没有联系人</div>}
          {visible.map((contact) => (
            <div
              key={contact.id}
              className={`address-book-row ${editing === contact.id ? 'editing' : ''}`}
            >
              <span className="book-name">{contact.name || '(无名字)'}</span>
              <span className="book-email">{contact.email}</span>
              <span className="book-actions">
                <button onClick={() => startEdit(contact)}>编辑</button>
                <button className="danger" onClick={() => void remove(contact)}>
                  删除
                </button>
              </span>
            </div>
          ))}
        </div>

        <div className="modal-actions">
          <button onClick={onClose}>关闭</button>
        </div>
      </div>
    </div>
  );
}
