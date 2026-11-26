import type { EngineFolder } from './types.ts';

/**
 * The order the special folders appear in, so the folder tree opens where
 * mail arrives: Inbox first, Trash last. Folders without a role (the user's
 * own, and containers like an account's `[Root]`) follow by name.
 */
export const ROLE_ORDER = ['inbox', 'drafts', 'sent', 'outbox', 'archive', 'spam', 'junk', 'trash'];

/** Where a folder sorts: its role's slot, or after every special folder. */
export function roleRank(folder: EngineFolder): number {
  const index = ROLE_ORDER.indexOf(folder.role ?? '');
  return index === -1 ? ROLE_ORDER.length : index;
}

/** Special folders by role, then everything else by name. */
export function byRoleThenName(a: EngineFolder, b: EngineFolder): number {
  return (
    roleRank(a) - roleRank(b) ||
    a.displayName.localeCompare(b.displayName, 'zh-Hans-CN', { sensitivity: 'base' })
  );
}

/** A copy of `folders` in the order the tree shows them. */
export function sortFolders(folders: EngineFolder[]): EngineFolder[] {
  return [...folders].sort(byRoleThenName);
}

/** 超过这个数就显示成 `999+`，免得一个导入的收件箱把侧栏撑开。 */
export const UNREAD_DISPLAY_CAP = 999;

/**
 * The 「(12)」 after a folder name, or null when there is nothing to show.
 *
 * Zero is hidden rather than written as 「(0)」: the tree is scanned for what
 * needs attention, and a column of zeroes is noise.
 */
export function unreadLabel(count: number | null | undefined): string | null {
  if (!count || count <= 0) return null;
  return count > UNREAD_DISPLAY_CAP ? ` (${UNREAD_DISPLAY_CAP}+)` : ` (${count})`;
}
