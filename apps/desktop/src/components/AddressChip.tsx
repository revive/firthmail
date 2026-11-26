import { useState } from 'react';
import { addressForCopy, displayAddress, mailtoHref } from '../address';
import { copyText } from '../clipboard';
import { api } from '../api';
import type { EngineAddress } from '../types';

interface Props {
  address: EngineAddress;
  /** 发件人那一行额外显示尖括号里的地址。 */
  showEmail?: boolean;
  /** 复制后的提示，通常在状态栏。 */
  onCopied?: (text: string) => void;
  /** 点击地址时用它（在应用里写新邮件）；没有才交给系统邮件程序。 */
  onOpen?: (email: string) => void;
}

/**
 * 一个邮件地址：鼠标移上去右边浮出两个按钮——复制「名字 <地址>」和只复制地址，
 * 地址本身是可以点的 mailto 链接（交给系统默认邮件程序打开，不留在应用里）。
 */
export default function AddressChip({ address, showEmail = false, onCopied, onOpen }: Props) {
  const [flash, setFlash] = useState<'full' | 'email' | null>(null);
  const name = displayAddress(address);
  const email = address.email?.trim() ?? '';
  const href = mailtoHref(address);

  const copy = async (kind: 'full' | 'email') => {
    const text = kind === 'full' ? addressForCopy(address) : email;
    const ok = await copyText(text);
    if (ok) {
      setFlash(kind);
      window.setTimeout(() => setFlash(null), 1200);
      onCopied?.(text);
    }
  };

  return (
    <span className="address-chip">
      {href ? (
        <a
          className="address-link"
          href={href}
          title={
            onOpen
              ? `给 ${email || name} 写新邮件`
              : `用默认邮件程序给 ${email || name} 写信`
          }
          onClick={(event) => {
            event.preventDefault();
            // 自己就是邮件客户端：优先在应用里写，不甩给系统默认程序。
            if (onOpen && email) {
              onOpen(email);
              return;
            }
            void api.openExternal(href).catch(() => {});
          }}
        >
          {name}
        </a>
      ) : (
        <span className="address-link">{name}</span>
      )}
      {showEmail && email && name !== email && (
        <span className="address-email">&lt;{email}&gt;</span>
      )}
      <span className="address-actions">
        <button
          type="button"
          title="复制「名字 &lt;地址&gt;」"
          onClick={(event) => {
            event.stopPropagation();
            void copy('full');
          }}
        >
          {flash === 'full' ? '✓' : '⧉'}
        </button>
        <button
          type="button"
          title="只复制地址"
          onClick={(event) => {
            event.stopPropagation();
            void copy('email');
          }}
        >
          {flash === 'email' ? '✓' : '@'}
        </button>
      </span>
    </span>
  );
}
