import { test } from 'node:test';
import assert from 'node:assert/strict';
import { percentile, summarize } from '../src/stats.js';

test('percentile interpolates linearly between ranks', () => {
  const sorted = [10, 20, 30, 40];
  assert.equal(percentile(sorted, 0), 10);
  assert.equal(percentile(sorted, 100), 40);
  assert.equal(percentile(sorted, 50), 25);
  assert.equal(percentile(sorted, 95), 38.5);
  assert.equal(percentile([7], 95), 7);
});

test('percentile rejects bad input', () => {
  assert.throws(() => percentile([], 50), RangeError);
  assert.throws(() => percentile([1], -1), RangeError);
  assert.throws(() => percentile([1], 101), RangeError);
  assert.throws(() => percentile([1], NaN), RangeError);
});

test('summarize does not depend on input order and does not mutate it', () => {
  const values = [300, 100, 200, 400, 1000];
  const copy = [...values];
  const { p95, ...rest } = summarize(values);
  assert.deepEqual(rest, { min: 100, max: 1000, mean: 400, median: 300 });
  assert.ok(Math.abs(p95 - 880) < 1e-9, `p95 = ${p95}`); // float arithmetic
  assert.deepEqual(values, copy);
});

test('summarize rejects an empty list', () => {
  assert.throws(() => summarize([]), RangeError);
});
