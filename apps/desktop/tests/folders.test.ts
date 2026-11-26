/**
 * The folder tree's order, run with `node --test` (`pnpm test`).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { byRoleThenName, roleRank, sortFolders, unreadLabel } from '../src/folders.ts';
import type { EngineFolder } from '../src/types.ts';

/** A folder, with just the fields the order looks at. */
function folder(id: number, displayName: string, role: string | null = null): EngineFolder {
  return { id, accountId: 1, displayName, path: displayName, role, selectable: true };
}

const names = (list: EngineFolder[]) => list.map((entry) => entry.displayName);

test('Inbox sorts before every other folder', () => {
  const list = [
    folder(1, 'Trash', 'trash'),
    folder(2, 'Archives', 'archive'),
    folder(3, 'Drafts', 'drafts'),
    folder(4, 'Junk', 'spam'),
    folder(5, 'INBOX', 'inbox'),
    folder(6, 'Sent', 'sent'),
    folder(7, 'old_tongzhi'),
  ];
  assert.equal(names(sortFolders(list))[0], 'INBOX');
});

test('special folders keep their order; the rest follow by name', () => {
  const list = [
    folder(1, 'Trash', 'trash'),
    folder(2, 'Archives', 'archive'),
    folder(3, 'Drafts', 'drafts'),
    folder(4, 'Junk', 'spam'),
    folder(5, 'INBOX', 'inbox'),
    folder(6, 'Sent', 'sent'),
    folder(7, 'old_tongzhi'),
    folder(8, 'android'),
  ];
  assert.deepEqual(names(sortFolders(list)), [
    'INBOX',
    'Drafts',
    'Sent',
    'Archives',
    'Junk',
    'Trash',
    'android',
    'old_tongzhi',
  ]);
});

test('a folder without a role sorts after all special ones', () => {
  assert.ok(roleRank(folder(1, 'x')) > roleRank(folder(2, 'y', 'trash')));
  assert.equal(byRoleThenName(folder(1, 'a'), folder(2, 'b')), -1);
});

test('the source array is left alone', () => {
  const list = [folder(1, 'z'), folder(2, 'a')];
  sortFolders(list);
  assert.deepEqual(names(list), ['z', 'a']);
});

test('a folder with no unread mail shows no number', () => {
  assert.equal(unreadLabel(0), null);
  assert.equal(unreadLabel(undefined), null);
  assert.equal(unreadLabel(-3), null);
});

test('unread mail shows its count in brackets, capped for huge mailboxes', () => {
  assert.equal(unreadLabel(1), ' (1)');
  assert.equal(unreadLabel(42), ' (42)');
  assert.equal(unreadLabel(999), ' (999)');
  assert.equal(unreadLabel(1000), ' (999+)');
});
