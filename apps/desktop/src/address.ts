import type { EngineAddress } from './types.ts';

/** 显示用的名字：有名字用名字，没有就用地址。 */
export function displayAddress(address: EngineAddress): string {
  return address.name?.trim() || address.email?.trim() || '(无名)';
}

/**
 * `mailto:` 链接。地址里的 `?`、`&`、`#` 必须转义，否则会被当成链接自己的
 * 参数分隔符；`@` 保留原样，兼容性最好。
 */
export function mailtoHref(address: EngineAddress): string {
  const email = address.email?.trim() ?? '';
  if (!email) return '';
  return `mailto:${encodeURIComponent(email).replace(/%40/gi, '@')}`;
}

/**
 * 「复制完整地址」放进剪贴板的内容：有名字时是 `名字 <地址>`，否则只有地址。
 */
export function addressForCopy(address: EngineAddress): string {
  const email = address.email?.trim() ?? '';
  const name = address.name?.trim() ?? '';
  if (!name || name === email) return email;
  return `${name} <${email}>`;
}
