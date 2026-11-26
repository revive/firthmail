/**
 * 地址簿的纯逻辑，run with `node --test`（`pnpm test`）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  containsAddress,
  currentFragment,
  replaceFragment,
  sameAddress,
  suggest,
  type Contact,
} from '../src/addressBook.ts';

function contact(id: number, name: string, email: string): Contact {
  return { id: String(id), name, email };
}

const book: Contact[] = [
  contact(1, '张三', 'zhang@example.org'),
  contact(2, 'Li Si', 'lisi@sjtu.edu.cn'),
  contact(3, '王五', 'wang@lab.example.org'),
];

test('the fragment is what follows the last separator', () => {
  assert.equal(currentFragment(''), '');
  assert.equal(currentFragment('a@x.com, b'), 'b');
  assert.equal(currentFragment('a@x.com; b@y'), 'b@y');
  assert.equal(currentFragment('a@x.com，张'), '张');
});

test('picking a contact replaces only the fragment being typed', () => {
  assert.equal(replaceFragment('', contact(1, '张三', 'z@x.com')), '张三 <z@x.com>');
  assert.equal(replaceFragment('a@x.com, zh', contact(1, '张三', 'z@x.com')), 'a@x.com, 张三 <z@x.com>');
  // 没有名字时只放地址，尖括号留空没有意义。
  assert.equal(replaceFragment('', contact(1, '', 'z@x.com')), 'z@x.com');
});

test('an address prefix ranks above a name match', () => {
  const result = suggest(book, 'li');
  assert.deepEqual(result.map((entry) => entry.email), ['lisi@sjtu.edu.cn']);
});

test('name and address matches both work, and empty input suggests nothing', () => {
  assert.deepEqual(suggest(book, '张').map((entry) => entry.email), ['zhang@example.org']);
  // 都是"地址包含"这一档，按名字排（拼音 王 < 张）。
  assert.deepEqual(suggest(book, 'example').map((entry) => entry.email), [
    'wang@lab.example.org',
    'zhang@example.org',
  ]);
  assert.deepEqual(suggest(book, ''), []);
});

test('the limit caps how many suggestions show', () => {
  assert.equal(suggest(book, 'e', 2).length, 2);
});

test('addresses are compared without case or padding', () => {
  assert.equal(sameAddress(' Zhang@Example.org ', 'zhang@example.org'), true);
  assert.equal(containsAddress(book, 'ZHANG@example.org'), true);
  assert.equal(containsAddress(book, 'nobody@example.org'), false);
});
