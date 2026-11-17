import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProgress } from '../src/progress.js';
import { createSink } from './helpers.js';

const CLEAR = '\r\x1b[K';

test('draws a line with percentage when the total is known', () => {
  const sink = createSink();
  const progress = createProgress(sink, { now: () => 0 });
  progress.update({ index: 3, warmup: false, bytes: 500_000, total: 2_000_000 });
  assert.equal(sink.text, `${CLEAR}  #3  0.50 MB / 2.00 MB (25%)`);
});

test('draws bytes only when the total is unknown, and labels warm-up', () => {
  const sink = createSink();
  createProgress(sink, { now: () => 0 }).update({
    index: 1,
    warmup: true,
    bytes: 1_500_000,
    total: null,
  });
  assert.equal(sink.text, `${CLEAR}  warm-up 1  1.50 MB`);
});

test('throttles redraws and clear() resets the throttle', () => {
  let t = 0;
  const sink = createSink();
  const progress = createProgress(sink, { now: () => t, intervalMs: 100 });
  const p = { index: 1, warmup: false, bytes: 1, total: null };

  progress.update(p); // drawn
  t = 50;
  progress.update(p); // skipped
  t = 150;
  progress.update(p); // drawn
  assert.equal(sink.text.split(CLEAR).length - 1, 2);

  progress.clear(); // erases the line
  progress.update(p); // drawn immediately despite t not moving
  assert.equal(sink.text.split(CLEAR).length - 1, 4);
});

test('clear() writes nothing if nothing is visible', () => {
  const sink = createSink();
  createProgress(sink).clear();
  assert.equal(sink.text, '');
});
