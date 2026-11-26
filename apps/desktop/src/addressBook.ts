/**
 * 本地地址簿的纯逻辑：条目类型、输入框里的片段、自动补全的排序。
 *
 * 存储只要求 name/email 两个字段，`extra` 是给以后留的口子（电话、公司、
 * 分组……）：前端加字段时不用改存储格式，旧文件照样能读。
 */
export interface Contact {
  id: string;
  name: string;
  email: string;
  extra?: Record<string, unknown>;
}

/** 地址比较大小写不敏感，和发信时一致。 */
export function sameAddress(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** 收件人输入框用逗号或分号分隔多个地址（中英文都认）。 */
const SEPARATORS = [',', ';', '，', '；'];

function lastSeparator(value: string): number {
  return SEPARATORS.reduce((index, separator) => Math.max(index, value.lastIndexOf(separator)), -1);
}

/** 光标所在的那一段：最后一个分隔符之后的文本。 */
export function currentFragment(value: string): string {
  return value.slice(lastSeparator(value) + 1).trim();
}

/** 把正在输入的那一段替换成选中的联系人。 */
export function replaceFragment(value: string, contact: Contact): string {
  const index = lastSeparator(value);
  const head = index >= 0 ? value.slice(0, index + 1).trimEnd() + ' ' : '';
  const formatted = contact.name ? `${contact.name} <${contact.email}>` : contact.email;
  return `${head}${formatted}`;
}

/**
 * 自动补全候选：地址前缀 > 名字前缀 > 名字包含 > 地址包含，同档按名字排。
 * 片段为空时不给建议——输入框刚获得焦点就弹一串名单反而碍事。
 */
export function suggest(contacts: Contact[], fragment: string, limit = 6): Contact[] {
  const needle = fragment.trim().toLowerCase();
  if (!needle) return [];
  const ranked: { contact: Contact; rank: number }[] = [];
  for (const contact of contacts) {
    const email = contact.email.toLowerCase();
    const name = contact.name.toLowerCase();
    let rank = -1;
    if (email.startsWith(needle)) rank = 0;
    else if (name.startsWith(needle)) rank = 1;
    else if (name.includes(needle)) rank = 2;
    else if (email.includes(needle)) rank = 3;
    if (rank >= 0) ranked.push({ contact, rank });
  }
  ranked.sort(
    (a, b) =>
      a.rank - b.rank ||
      a.contact.name.localeCompare(b.contact.name, 'zh-Hans-CN', { sensitivity: 'base' }) ||
      a.contact.email.localeCompare(b.contact.email),
  );
  return ranked.slice(0, limit).map((entry) => entry.contact);
}

/** 新条目的骨架（id 由存储侧生成，这里留空）。 */
export function draftContact(name = '', email = ''): Contact {
  return { id: '', name, email };
}

/** 地址簿里是否已经有这个地址。 */
export function containsAddress(contacts: Contact[], email: string): boolean {
  return contacts.some((contact) => sameAddress(contact.email, email));
}
