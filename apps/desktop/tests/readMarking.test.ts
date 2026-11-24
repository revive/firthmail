/**
 * The read-marking rules the UI depends on, run with `node --test`
 * (`pnpm test` in apps/desktop). Node runs the .ts files directly.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  autoReadDue,
  readActionKind,
  startsAutoReadWait,
  toggledReadState,
  type AutoReadWait,
} from '../src/readMarking.ts';

test('a toggle asks for the opposite of the message\'s current state', () => {
  assert.equal(toggledReadState(false), true, 'unread → read');
  assert.equal(toggledReadState(true), false, 'read → unread');
});

test('the wanted read state maps to the engine action of that state', () => {
  // 2026-11-24: the pane passed "set it unread" while the button said
  // "mark it read", so every click asked for the state the message already
  // had. The engine skips such no-ops silently, and the button looked dead.
  assert.equal(readActionKind(toggledReadState(false)), 'mark_read');
  assert.equal(readActionKind(toggledReadState(true)), 'mark_unread');
  assert.equal(readActionKind(true), 'mark_read', 'Ctrl+Q / 标为已读');
  assert.equal(readActionKind(false), 'mark_unread', 'Ctrl+U / 标为未读');
});

test('only unread mail waits to be auto-marked', () => {
  assert.equal(startsAutoReadWait(false), true);
  assert.equal(startsAutoReadWait(true), false);
});

test('the auto-read wait only fires for the message still on screen', () => {
  const wait: AutoReadWait = { id: 7, suppressed: false };
  assert.equal(autoReadDue(wait, 7, 7), true, 'same message, still selected');
  assert.equal(autoReadDue(wait, 7, 8), false, 'the user moved to another message');
  assert.equal(autoReadDue(wait, 8, 8), false, 'the wait belongs to message 7');
  assert.equal(autoReadDue(wait, 7, null), false, 'nothing is selected');
});

test('a manual toggle keeps the message from being auto-marked', () => {
  const wait: AutoReadWait = { id: 7, suppressed: true };
  assert.equal(autoReadDue(wait, 7, 7), false);
});
