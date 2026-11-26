/**
 * 正文缓存：来回翻邮件时秒开，run with `node --test`（`pnpm test`）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BodyCache } from '../src/bodyCache.ts';
import type { EngineMessageDetail } from '../src/types.ts';

function detail(id: number, text = 'hello'): EngineMessageDetail {
  return {
    id,
    accountId: 1,
    subject: `#${id}`,
    from: { email: 'a@example.org' },
    to: [],
    cc: [],
    date: id,
    isRead: false,
    isStarred: false,
    htmlBody: null,
    textBody: text,
    attachments: [],
  };
}

test('a cached body comes back without asking the engine again', () => {
  const cache = new BodyCache();
  cache.set(1, detail(1));
  assert.equal(cache.get(1)?.subject, '#1');
  assert.equal(cache.isFresh(1), true);
  assert.equal(cache.isFresh(2), false);
});

test('the least recently used body is dropped first', () => {
  const cache = new BodyCache(2);
  cache.set(1, detail(1));
  cache.set(2, detail(2));
  // 用一下 1，最久没用的就变成 2。
  cache.get(1);
  cache.set(3, detail(3));
  assert.equal(cache.get(2), undefined);
  assert.equal(cache.get(1)?.subject, '#1');
  assert.equal(cache.get(3)?.subject, '#3');
});

test('a body older than the ttl is refetched', () => {
  const cache = new BodyCache();
  cache.set(1, detail(1), 1_000);
  assert.equal(cache.isFresh(1, 1_000 + 60_000), true);
  assert.equal(cache.isFresh(1, 1_000 + 6 * 60_000), false);
});

test('patching keeps the entry but changes one field', () => {
  const cache = new BodyCache();
  cache.set(1, detail(1));
  cache.patch(1, { isRead: true });
  assert.equal(cache.get(1)?.isRead, true);
  assert.equal(cache.size, 1);
});

test('big bodies count against the character budget', () => {
  const cache = new BodyCache(10, 10);
  cache.set(1, detail(1, 'x'.repeat(8)));
  cache.set(2, detail(2, 'y'.repeat(8)));
  assert.equal(cache.get(1), undefined);
  assert.equal(cache.get(2)?.subject, '#2');
  assert.equal(cache.chars, 8);
});
