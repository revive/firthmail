/**
 * 复制地址用的格式化，run with `node --test`（`pnpm test`）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addressForCopy, displayAddress, mailtoHref } from '../src/address.ts';

test('the name is shown, or the address when there is no name', () => {
  assert.equal(displayAddress({ name: '张三', email: 'z@example.org' }), '张三');
  assert.equal(displayAddress({ email: 'z@example.org' }), 'z@example.org');
  assert.equal(displayAddress({ name: '  ', email: 'z@example.org' }), 'z@example.org');
});

test('the full copy keeps the name with the address', () => {
  assert.equal(addressForCopy({ name: '张三', email: 'z@example.org' }), '张三 <z@example.org>');
  assert.equal(addressForCopy({ email: 'z@example.org' }), 'z@example.org');
  // 名字就是地址时不必重复。
  assert.equal(addressForCopy({ name: 'z@example.org', email: 'z@example.org' }), 'z@example.org');
});

test('a mailto link escapes what would end the address', () => {
  assert.equal(mailtoHref({ email: 'z@example.org' }), 'mailto:z@example.org');
  assert.equal(
    mailtoHref({ email: 'a+b@example.org' }),
    'mailto:a%2Bb@example.org',
  );
  assert.equal(
    mailtoHref({ email: 'a&b@example.org' }),
    'mailto:a%26b@example.org',
  );
  assert.equal(mailtoHref({ name: '没有地址', email: '' }), '');
});
