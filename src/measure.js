import { summarize } from './stats.js';

/**
 * @typedef {import('./stats.js').Summary} Summary
 *
 * @typedef {Object} Sample
 * @property {number} index    1-based number within its phase (warm-up or measured)
 * @property {boolean} warmup  true for warm-up requests (not counted in results)
 * @property {number} attempts 1 unless the request was retried
 * @property {number} status   HTTP status code
 * @property {number} bytes    body bytes received
 * @property {number} ttfbMs   time from sending the request to receiving response headers
 * @property {number} ms       time from sending the request to the last body byte
 *
 * @typedef {Object} Progress
 * @property {number} index
 * @property {boolean} warmup
 * @property {number} bytes        received so far
 * @property {number | null} total from Content-Length, if known
 *
 * @typedef {Object} Result
 * @property {string} url
 * @property {Sample[]} samples   measured requests only (no warm-up)
 * @property {number} totalBytes
 * @property {number} totalMs
 * @property {number} avgMs
 * @property {number} bytesPerSecond total bytes / total time
 * @property {Summary} time       per-request total time, ms
 * @property {Summary} ttfb       per-request time to first byte, ms
 *
 * @typedef {Object} MeasureOptions
 * @property {number} [requests=10]      measured requests
 * @property {number} [warmup=0]         extra requests made first and not counted
 * @property {number} [retries=0]        extra attempts per request on transient failures
 * @property {number} [retryDelayMs=500] first retry delay, doubled on each next attempt
 * @property {number} [timeoutMs=30000]  limit for one attempt, body included
 * @property {typeof fetch} [fetchImpl]
 * @property {() => number} [now]        monotonic clock, ms
 * @property {(ms: number) => Promise<void>} [sleep]
 * @property {(sample: Sample) => void} [onSample]
 * @property {(progress: Progress) => void} [onProgress]
 */

const REQUEST_HEADERS = {
  'cache-control': 'no-cache',
  // Ask for the body as stored, so counted bytes match bytes on the wire.
  'accept-encoding': 'identity',
  // Some CDNs reject requests without a descriptive User-Agent (HTTP 429/403).
  'user-agent': 'internet-speed-test/2.0',
};

/** Statuses worth retrying: the server may succeed on the next attempt. */
const RETRIABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} statusText
   */
  constructor(status, statusText) {
    super(`HTTP ${status}${statusText ? ` ${statusText}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

/**
 * Network errors and timeouts are transient; of HTTP errors only some are.
 * @param {unknown} error
 */
export function isRetriable(error) {
  if (error instanceof HttpError) return RETRIABLE_STATUSES.has(error.status);
  return true;
}

/**
 * Make sequential GET requests to `url` and measure them.
 * Each request is awaited until its body is fully read before the next starts.
 * The body is streamed and only counted, never buffered, so memory stays flat
 * even for large files.
 *
 * A request that still fails after its retries aborts the whole run:
 * a partial measurement would be misleading.
 *
 * @param {string | URL} url
 * @param {MeasureOptions} [options]
 * @returns {Promise<Result>}
 */
export async function measure(url, options = {}) {
  const {
    requests = 10,
    warmup = 0,
    retries = 0,
    retryDelayMs = 500,
    timeoutMs = 30_000,
    fetchImpl = globalThis.fetch,
    now = () => performance.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onSample = () => {},
    onProgress = () => {},
  } = options;

  const target = parseUrl(url);
  assertInteger('requests', requests, 1);
  assertInteger('warmup', warmup, 0);
  assertInteger('retries', retries, 0);
  if (!(timeoutMs > 0)) throw new RangeError('timeoutMs must be a positive number');
  if (!(retryDelayMs >= 0)) throw new RangeError('retryDelayMs must be a non-negative number');

  const ctx = { target, retries, retryDelayMs, timeoutMs, fetchImpl, now, sleep, onProgress };

  for (let index = 1; index <= warmup; index++) {
    onSample(await request(ctx, index, true, `Warm-up request ${index}/${warmup}`));
  }

  /** @type {Sample[]} */
  const samples = [];
  for (let index = 1; index <= requests; index++) {
    const sample = await request(ctx, index, false, `Request ${index}/${requests}`);
    samples.push(sample);
    onSample(sample);
  }

  const totalBytes = samples.reduce((sum, s) => sum + s.bytes, 0);
  const totalMs = samples.reduce((sum, s) => sum + s.ms, 0);
  return {
    url: target.href,
    samples,
    totalBytes,
    totalMs,
    avgMs: totalMs / samples.length,
    // Weighted: total data over total time, not the mean of per-request speeds.
    bytesPerSecond: totalMs > 0 ? totalBytes / (totalMs / 1000) : 0,
    time: summarize(samples.map((s) => s.ms)),
    ttfb: summarize(samples.map((s) => s.ttfbMs)),
  };
}

/**
 * One logical request with retries. Only the successful attempt is timed:
 * failed attempts and back-off pauses say nothing about download speed.
 *
 * @param {RequestContext} ctx
 * @param {number} index
 * @param {boolean} warmup
 * @param {string} label used in the error message
 * @returns {Promise<Sample>}
 */
async function request(ctx, index, warmup, label) {
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await fetchOnce(ctx, (bytes, total) =>
        ctx.onProgress({ index, warmup, bytes, total }),
      );
      return { index, warmup, attempts: attempt, ...result };
    } catch (error) {
      if (attempt <= ctx.retries && isRetriable(error)) {
        await ctx.sleep(ctx.retryDelayMs * 2 ** (attempt - 1));
        continue;
      }
      const after = attempt > 1 ? ` (after ${attempt} attempts)` : '';
      throw new Error(`${label} failed${after}: ${describe(error, ctx.timeoutMs)}`, {
        cause: error,
      });
    }
  }
}

/**
 * @typedef {Object} RequestContext
 * @property {URL} target
 * @property {number} retries
 * @property {number} retryDelayMs
 * @property {number} timeoutMs
 * @property {typeof fetch} fetchImpl
 * @property {() => number} now
 * @property {(ms: number) => Promise<void>} sleep
 * @property {(progress: Progress) => void} onProgress
 */

/**
 * @param {RequestContext} ctx
 * @param {(bytes: number, total: number | null) => void} onChunk
 */
async function fetchOnce({ target, timeoutMs, fetchImpl, now }, onChunk) {
  const start = now();
  // The signal also aborts reading the body, so a stalled download times out too.
  const response = await fetchImpl(target, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: REQUEST_HEADERS,
  });
  const ttfbMs = now() - start;

  if (!response.ok) {
    await response.body?.cancel(); // release the connection
    throw new HttpError(response.status, response.statusText);
  }

  const total = Number(response.headers.get('content-length')) || null;
  let bytes = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      onChunk(bytes, total);
    }
  }
  return { status: response.status, bytes, ttfbMs, ms: now() - start };
}

/**
 * Validate a target URL (http/https only).
 * @param {string | URL} input
 * @returns {URL}
 */
export function parseUrl(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new TypeError(`Invalid URL: ${input}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`Unsupported protocol "${url.protocol}" (only http and https)`);
  }
  return url;
}

/**
 * @param {string} name
 * @param {number} value
 * @param {number} min
 */
function assertInteger(name, value, min) {
  if (!Number.isInteger(value) || value < min) {
    throw new RangeError(`${name} must be an integer >= ${min}`);
  }
}

/**
 * @param {any} error
 * @param {number} timeoutMs
 * @returns {string}
 */
function describe(error, timeoutMs) {
  if (error?.name === 'TimeoutError') return `timed out after ${timeoutMs} ms`;
  // fetch wraps the real network error ("fetch failed") in `cause`.
  return error?.cause?.message ?? error?.message ?? String(error);
}
