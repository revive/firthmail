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
