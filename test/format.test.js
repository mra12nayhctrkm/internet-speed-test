import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMBps, formatMbit, formatMegabytes, formatMs, toMbit } from '../src/format.js';

test('converts bytes/s to Mbit/s using decimal units', () => {
  assert.equal(toMbit(125_000), 1); // 125 000 B/s = 1 000 000 bit/s
  assert.equal(formatMbit(12_500_000), '100.00 Mbit/s');
});

test('formats MB/s, MB and ms', () => {
  assert.equal(formatMBps(1_500_000), '1.50 MB/s');
  assert.equal(formatMegabytes(2_345_678), '2.35 MB');
  assert.equal(formatMs(12.345), '12.3 ms');
});
