/**
 * 慢来的正文答复要能作废，run with `node --test`（`pnpm test`）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { RequestGate } from '../src/selection.ts';

test('the latest request is the one that counts', () => {
  const gate = new RequestGate();
  const token = gate.start();
  assert.equal(gate.current(token), true);
});

test('a new request makes the previous answer stale', () => {
  const gate = new RequestGate();
  const first = gate.start();
  const second = gate.start();
  assert.equal(gate.current(first), false);
  assert.equal(gate.current(second), true);
});

test('clicking three times shows only the last body', () => {
  const gate = new RequestGate();
  const answers = [gate.start(), gate.start(), gate.start()];
  assert.deepEqual(
    answers.filter((token) => gate.current(token)),
    [answers[2]],
  );
});
