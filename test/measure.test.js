import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError, isRetriable, measure } from '../src/measure.js';
import { startServer } from './helpers.js';

const PAYLOAD_SIZE = 256 * 1024;
const payload = Buffer.alloc(PAYLOAD_SIZE, 'x');
const URL_ = 'http://example.test/file';

/** Fake clock: returns the given times in order, one per now() call. */
function fakeClock(/** @type {number[]} */ times) {
  let i = 0;
  return () => {
    if (i >= times.length) throw new Error('clock exhausted');
    return times[i++];
  };
}

/** fetch stub that answers from a list of factories, one per call. */
function scriptedFetch(/** @type {Array<() => Response | Promise<Response>>} */ steps) {
  const fn = async () => {
    const step = steps[fn.calls++];
    if (!step) throw new Error('unexpected extra request');
    return step();
  };
  fn.calls = 0;
  return fn;
}

const ok =
  (body = 'ok') =>
  () =>
    new Response(body);
const status = (/** @type {number} */ code) => () => new Response('err', { status: code });
const networkError = () => () => {
  throw new TypeError('fetch failed', { cause: new Error('read ECONNRESET') });
};
const noSleep = async () => {};

test('computes totals, average, speed and stats with a deterministic clock', async () => {
  // Each request reads the clock 3 times: start, headers (TTFB), end.
  const result = await measure(URL_, {
    requests: 2,
    fetchImpl: async () => new Response(Buffer.alloc(1000)),
    now: fakeClock([0, 20, 100, 500, 560, 800]),
  });

  assert.equal(result.totalBytes, 2000);
  assert.equal(result.totalMs, 400);
  assert.equal(result.avgMs, 200);
  // 2000 B / 0.4 s = 5000 B/s (weighted, not mean of 10000 and 3333 B/s).
  assert.equal(result.bytesPerSecond, 5000);
  assert.deepEqual(
    result.samples.map((s) => [s.index, s.bytes, s.ttfbMs, s.ms, s.attempts, s.warmup]),
    [
      [1, 1000, 20, 100, 1, false],
      [2, 1000, 60, 300, 1, false],
    ],
  );
  assert.deepEqual(result.time, { min: 100, max: 300, mean: 200, median: 200, p95: 290 });
  assert.equal(result.ttfb.median, 40);
});

test('makes exactly 10 requests by default, one at a time, reading full bodies', async () => {
  let active = 0;
  let maxActive = 0;
  let total = 0;
  const server = await startServer((_req, res) => {
    total++;
    active++;
    maxActive = Math.max(maxActive, active);
    res.on('close', () => active--);
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    // Send in two parts to prove we wait for the complete body.
    res.write(payload.subarray(0, PAYLOAD_SIZE / 2));
    setTimeout(() => res.end(payload.subarray(PAYLOAD_SIZE / 2)), 5);
  });
  try {
    const result = await measure(server.url);
    assert.equal(total, 10);
    assert.equal(result.samples.length, 10);
    assert.equal(maxActive, 1, 'requests must be sequential');
    assert.equal(result.totalBytes, 10 * PAYLOAD_SIZE);
    assert.ok(result.samples.every((s) => s.bytes === PAYLOAD_SIZE));
    assert.ok(result.avgMs >= 5, 'each request waits for the delayed second half');
    assert.ok(result.samples.every((s) => s.ttfbMs <= s.ms));
    assert.ok(result.bytesPerSecond > 0);
  } finally {
    await server.close();
  }
});

test('sends identity encoding, no-cache and a User-Agent', async () => {
  /** @type {import('node:http').IncomingHttpHeaders | undefined} */
  let headers;
  const server = await startServer((req, res) => {
    headers = req.headers;
    res.end('x');
  });
  try {
    await measure(server.url, { requests: 1 });
    assert.equal(headers?.['accept-encoding'], 'identity');
    assert.equal(headers?.['cache-control'], 'no-cache');
    assert.match(headers?.['user-agent'] ?? '', /^internet-speed-test\//);
  } finally {
    await server.close();
  }
});

test('calls onSample after every request', async () => {
  /** @type {number[]} */
  const seen = [];
  await measure(URL_, {
    requests: 3,
    fetchImpl: async () => new Response('abc'),
    onSample: (s) => seen.push(s.index),
  });
  assert.deepEqual(seen, [1, 2, 3]);
});

test('reports progress with Content-Length as total', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200, { 'content-length': PAYLOAD_SIZE });
    res.write(payload.subarray(0, 1000));
    setTimeout(() => res.end(payload.subarray(1000)), 5);
  });
  try {
    /** @type {import('../src/measure.js').Progress[]} */
    const updates = [];
    await measure(server.url, { requests: 1, onProgress: (p) => updates.push(p) });
    assert.ok(updates.length >= 2, 'body arrived in at least two chunks');
    assert.ok(updates.every((u) => u.total === PAYLOAD_SIZE && u.index === 1 && !u.warmup));
    assert.equal(updates.at(-1)?.bytes, PAYLOAD_SIZE);
    for (let i = 1; i < updates.length; i++) assert.ok(updates[i].bytes > updates[i - 1].bytes);
  } finally {
    await server.close();
  }
});

test('progress total is null without Content-Length', async () => {
  /** @type {Array<number | null>} */
  const totals = [];
  await measure(URL_, {
    requests: 1,
    fetchImpl: async () => new Response(new Blob(['abc']).stream()),
    onProgress: (p) => totals.push(p.total),
  });
  assert.deepEqual(totals, [null]);
});

test('warm-up requests run first and are not counted', async () => {
  const fetchImpl = scriptedFetch([ok('w1'), ok('w2'), ok('a'), ok('b'), ok('c')]);
  /** @type {Array<[boolean, number]>} */
  const seen = [];
  const result = await measure(URL_, {
    requests: 3,
    warmup: 2,
    fetchImpl,
    onSample: (s) => seen.push([s.warmup, s.index]),
  });
  assert.equal(fetchImpl.calls, 5);
  assert.equal(result.samples.length, 3);
  assert.equal(result.totalBytes, 3, 'only measured bodies count');
  assert.deepEqual(seen, [
    [true, 1],
    [true, 2],
    [false, 1],
    [false, 2],
    [false, 3],
  ]);
});

test('a failing warm-up request is reported as such', async () => {
  await assert.rejects(
    measure(URL_, { warmup: 1, fetchImpl: scriptedFetch([status(500)]) }),
    /^Error: Warm-up request 1\/1 failed: HTTP 500/,
  );
});

test('retries transient failures with exponential back-off', async () => {
  /** @type {number[]} */
  const delays = [];
  const fetchImpl = scriptedFetch([status(503), networkError(), ok('done')]);
  const result = await measure(URL_, {
    requests: 1,
    retries: 3,
    retryDelayMs: 100,
    fetchImpl,
    sleep: async (ms) => {
      delays.push(ms);
    },
  });
  assert.equal(fetchImpl.calls, 3);
  assert.deepEqual(delays, [100, 200]);
  assert.equal(result.samples[0].attempts, 3);
  assert.equal(result.totalBytes, 4);
});

test('only the successful attempt is timed', async () => {
  const result = await measure(URL_, {
    requests: 1,
    retries: 1,
    fetchImpl: scriptedFetch([status(503), ok()]),
    sleep: noSleep,
    // failed attempt: start 0, headers 1000; successful: start 5000, headers 5010, end 5050
    now: fakeClock([0, 1000, 5000, 5010, 5050]),
  });
  assert.equal(result.samples[0].ms, 50);
  assert.equal(result.samples[0].ttfbMs, 10);
});

test('does not retry permanent HTTP errors', async () => {
  const fetchImpl = scriptedFetch([status(404)]);
  await assert.rejects(
    measure(URL_, { requests: 1, retries: 5, fetchImpl, sleep: noSleep }),
    /^Error: Request 1\/1 failed: HTTP 404/,
  );
  assert.equal(fetchImpl.calls, 1);
});

test('gives up after the configured retries', async () => {
  const fetchImpl = scriptedFetch([status(502), status(502), status(502)]);
  await assert.rejects(
    measure(URL_, { requests: 1, retries: 2, fetchImpl, sleep: noSleep }),
    /Request 1\/1 failed \(after 3 attempts\): HTTP 502/,
  );
  assert.equal(fetchImpl.calls, 3);
});

test('retries a timed-out attempt', async () => {
  let calls = 0;
  const server = await startServer((_req, res) => {
    if (++calls === 1) return; // first attempt hangs
    res.end('ok');
  });
  try {
    const result = await measure(server.url, {
      requests: 1,
      retries: 1,
      retryDelayMs: 0,
      timeoutMs: 100,
    });
    assert.equal(result.samples[0].attempts, 2);
  } finally {
    await server.close();
  }
});

test('isRetriable classifies errors', () => {
  assert.equal(isRetriable(new HttpError(503, '')), true);
  assert.equal(isRetriable(new HttpError(429, '')), true);
  assert.equal(isRetriable(new HttpError(404, '')), false);
  assert.equal(isRetriable(new HttpError(401, '')), false);
  assert.equal(isRetriable(new TypeError('fetch failed')), true);
});

test('handles an empty body (0 bytes, speed 0)', async () => {
  const result = await measure(URL_, {
    requests: 1,
    fetchImpl: async () => new Response(null, { status: 200 }),
  });
  assert.equal(result.totalBytes, 0);
  assert.equal(result.bytesPerSecond, 0);
});

test('returns speed 0 instead of Infinity when elapsed time is 0', async () => {
  const result = await measure(URL_, {
    requests: 1,
    fetchImpl: async () => new Response('abc'),
    now: () => 42,
  });
  assert.equal(result.totalMs, 0);
  assert.equal(result.bytesPerSecond, 0);
});

test('fails on non-2xx status and names the request', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(404).end('nope');
  });
  try {
    await assert.rejects(measure(server.url, { requests: 3 }), /Request 1\/3 failed: HTTP 404/);
  } finally {
    await server.close();
  }
});

test('fails when a later request fails', async () => {
  await assert.rejects(
    measure(URL_, { requests: 5, fetchImpl: scriptedFetch([ok(), ok(), status(500)]) }),
    /Request 3\/5 failed: HTTP 500/,
  );
});

test('times out a hanging server', async () => {
  const server = await startServer(() => {
    /* never respond */
  });
  try {
    await assert.rejects(
      measure(server.url, { requests: 1, timeoutMs: 100 }),
      /timed out after 100 ms/,
    );
  } finally {
    await server.close();
  }
});

test('times out when the body stalls midway', async () => {
  const server = await startServer((_req, res) => {
    res.writeHead(200);
    res.write('partial'); // headers + some data, then silence
  });
  try {
    await assert.rejects(
      measure(server.url, { requests: 1, timeoutMs: 150 }),
      /timed out after 150 ms/,
    );
  } finally {
    await server.close();
  }
});

test('reports a connection error with a readable message', async () => {
  const server = await startServer(() => {});
  const { url } = server;
  await server.close(); // port is now closed
  await assert.rejects(measure(url, { requests: 1 }), /Request 1\/1 failed: .*ECONNREFUSED/);
});

test('follows redirects', async () => {
  const server = await startServer((req, res) => {
    if (req.url === '/final') return res.end(payload);
    res.writeHead(302, { location: '/final' }).end();
  });
  try {
    const result = await measure(server.url, { requests: 1 });
    assert.equal(result.totalBytes, PAYLOAD_SIZE);
  } finally {
    await server.close();
  }
});

test('rejects invalid input', async () => {
  await assert.rejects(measure('not a url'), { name: 'TypeError', message: /Invalid URL/ });
  await assert.rejects(measure('ftp://example.com/file'), {
    name: 'TypeError',
    message: /Unsupported protocol/,
  });
  for (const options of [
    { requests: 0 },
    { requests: 1.5 },
    { warmup: -1 },
    { retries: 0.5 },
    { timeoutMs: 0 },
    { retryDelayMs: -1 },
  ]) {
    await assert.rejects(measure(URL_, options), RangeError, JSON.stringify(options));
  }
});
