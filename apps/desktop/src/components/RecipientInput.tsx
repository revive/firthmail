import { useMemo, useState } from 'react';
import { currentFragment, replaceFragment, suggest, type Contact } from '../addressBook';

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** 地址簿里的条目，用来补全。 */
  contacts: Contact[];
  placeholder?: string;
  autoFocus?: boolean;
}

/**
 * 收件人/抄送/密件抄送输入框：逗号分隔多个地址，输入时从地址簿补全。
 *
 * 补全只看正在输入的那一段；选中后只替换那一段，前面已经填好的地址不动。
 * ↑↓ 选择、Enter/Tab 确认、Esc 关掉候选。
 */
export default function RecipientInput({
  value,
  onChange,
  contacts,
  placeholder,
  autoFocus = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const suggestions = useMemo(
    () => (open ? suggest(contacts, currentFragment(value)) : []),
    [open, contacts, value],
  );

  const pick = (contact: Contact) => {
    onChange(replaceFragment(value, contact));
    setOpen(false);
    setActive(0);
  };

  return (
    <span className="recipient-input">
      <input
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (suggestions.length === 0) {
            if (event.key === 'Escape') setOpen(false);
            return;
          }
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActive((index) => (index + 1) % suggestions.length);
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive((index) => (index - 1 + suggestions.length) % suggestions.length);
          } else if (event.key === 'Enter' || event.key === 'Tab') {
            event.preventDefault();
            pick(suggestions[Math.min(active, suggestions.length - 1)]);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            setOpen(false);
          }
        }}
        onBlur={() => {
          // 让 click 先落到候选上再关闭。
          window.setTimeout(() => setOpen(false), 120);
        }}
      />
      {suggestions.length > 0 && (
        <ul className="contact-suggest" role="listbox" aria-label="地址簿候选">
          {suggestions.map((contact, index) => (
            <li
              key={contact.id}
              role="option"
              aria-selected={index === active}
              className={index === active ? 'active' : undefined}
              onMouseDown={(event) => {
                event.preventDefault();
                pick(contact);
              }}
            >
              <span className="contact-name">{contact.name || contact.email}</span>
              {contact.name && <span className="contact-email">{contact.email}</span>}
            </li>
          ))}
        </ul>
      )}
    </span>
  );
}
