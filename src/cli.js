import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { measure, parseUrl } from './measure.js';
import { formatMbit, formatMBps, formatMegabytes, formatMs, toMbit } from './format.js';
import { createProgress } from './progress.js';

const USAGE = `Usage: speedtest <url> [options]

Makes sequential GET requests to <url> and reports the download speed.

Options:
  -n, --requests <n>   measured requests (default: 10)
  -w, --warmup <n>     warm-up requests before measuring, not counted (default: 0)
  -r, --retries <n>    retries per request on network errors, timeouts,
                       408/425/429/5xx, with exponential back-off (default: 0)
  -t, --timeout <sec>  timeout per attempt, body included (default: 30)
      --json           print the result as JSON
  -h, --help           show this help
  -V, --version        show the version
`;

/**
 * @typedef {{ write(s: string): unknown, isTTY?: boolean }} Output
 *
 * @typedef {Object} Options
 * @property {URL} url
 * @property {number} requests
 * @property {number} warmup
 * @property {number} retries
 * @property {number} timeoutMs
 * @property {boolean} json
 */

class UsageError extends Error {}

/**
 * Run the CLI. Returns the process exit code instead of exiting,
 * so it can be tested without spawning a process.
 *
 * Exit codes: 0 success, 1 measurement failed, 2 bad usage.
 *
 * @param {string[]} argv
 * @param {{ stdout?: Output, stderr?: Output, fetchImpl?: typeof fetch, retryDelayMs?: number }} [io]
 * @returns {Promise<number>}
 */
export async function run(
  argv,
  { stdout = process.stdout, stderr = process.stderr, fetchImpl, retryDelayMs } = {},
) {
  /** @type {Options | 'help' | 'version'} */
  let options;
  try {
    options = parseOptions(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    stderr.write(`Error: ${error.message}\n\nRun "speedtest --help" for usage.\n`);
    return 2;
  }
  if (options === 'help') {
    stdout.write(USAGE);
    return 0;
  }
  if (options === 'version') {
    stdout.write(`${readVersion()}\n`);
    return 0;
  }

  const { json } = options;
  // Progress goes to stderr and only to a terminal: never pollutes pipes or JSON.
  const progress = !json && stderr.isTTY ? createProgress(stderr) : null;

  if (!json) {
    stdout.write(`Target: ${options.url.href}\n`);
    if (options.warmup > 0) stdout.write(`Warm-up: ${options.warmup} (not counted)\n`);
  }

  try {
    const result = await measure(options.url, {
      requests: options.requests,
      warmup: options.warmup,
      retries: options.retries,
      timeoutMs: options.timeoutMs,
      fetchImpl,
      retryDelayMs,
      onProgress: progress ? (p) => progress.update(p) : undefined,
      onSample: (s) => {
        progress?.clear();
        if (!json) stdout.write(renderSample(s));
      },
    });
    stdout.write(json ? `${JSON.stringify(toJson(result), null, 2)}\n` : renderSummary(result));
    return 0;
  } catch (error) {
    progress?.clear();
    stderr.write(`Error: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/**
 * @param {string[]} argv
 * @returns {Options | 'help' | 'version'}
 */
function parseOptions(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        requests: { type: 'string', short: 'n', default: '10' },
        warmup: { type: 'string', short: 'w', default: '0' },
        retries: { type: 'string', short: 'r', default: '0' },
        timeout: { type: 'string', short: 't', default: '30' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'V', default: false },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }

  const { values, positionals } = parsed;
  if (values.help) return 'help';
  if (values.version) return 'version';
  if (positionals.length !== 1) throw new UsageError('expected exactly one URL');

  let url;
  try {
    url = parseUrl(positionals[0]);
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }

  const timeout = Number(values.timeout);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new UsageError(`--timeout must be a positive number, got "${values.timeout}"`);
  }

  return {
    url,
    requests: parseCount('--requests', values.requests, 1),
    warmup: parseCount('--warmup', values.warmup, 0),
    retries: parseCount('--retries', values.retries, 0),
    timeoutMs: timeout * 1000,
    json: values.json,
  };
}

/**
 * @param {string} name
 * @param {string} raw
 * @param {number} min
 */
function parseCount(name, raw, min) {
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min) {
    throw new UsageError(`${name} must be an integer >= ${min}, got "${raw}"`);
  }
  return value;
}

/** @param {import('./measure.js').Sample} s */
function renderSample(s) {
  const label = s.warmup ? `warm-up ${s.index}` : `#${String(s.index).padStart(2)}`;
  const retried = s.attempts > 1 ? `  (attempt ${s.attempts})` : '';
  return (
    `  ${label.padEnd(9)} ${formatMegabytes(s.bytes).padStart(10)}` +
    `  ${formatMs(s.ms).padStart(10)}  TTFB ${formatMs(s.ttfbMs).padStart(9)}${retried}\n`
  );
}

/** @param {import('./stats.js').Summary} stats */
function renderStats(stats) {
  const f = (/** @type {number} */ v) => v.toFixed(1);
  return `min ${f(stats.min)} · median ${f(stats.median)} · p95 ${f(stats.p95)} · max ${f(stats.max)}`;
}

/** @param {import('./measure.js').Result} r */
function renderSummary(r) {
  return [
    '',
    `Requests:       ${r.samples.length}`,
    `Total data:     ${formatMegabytes(r.totalBytes)}`,
    `Average time:   ${formatMs(r.avgMs)} per request`,
    `Time, ms:       ${renderStats(r.time)}`,
    `TTFB, ms:       ${renderStats(r.ttfb)}`,
    `Download speed: ${formatMbit(r.bytesPerSecond)} (${formatMBps(r.bytesPerSecond)})`,
    '',
  ].join('\n');
}

/**
 * Round to 3 decimals: µs precision for ms values is more than the clock gives.
 * @param {number} v
 */
const round = (v) => Math.round(v * 1000) / 1000;

/** @param {import('./stats.js').Summary} s */
const roundStats = (s) => ({
  min: round(s.min),
  max: round(s.max),
  mean: round(s.mean),
  median: round(s.median),
  p95: round(s.p95),
});

/** @param {import('./measure.js').Result} r */
function toJson(r) {
  return {
    url: r.url,
    requests: r.samples.length,
    totalBytes: r.totalBytes,
    totalMs: round(r.totalMs),
    avgMs: round(r.avgMs),
    bytesPerSecond: Math.round(r.bytesPerSecond),
    mbitPerSecond: round(toMbit(r.bytesPerSecond)),
    timeMs: roundStats(r.time),
    ttfbMs: roundStats(r.ttfb),
    samples: r.samples.map(({ index, attempts, status, bytes, ttfbMs, ms }) => ({
      index,
      attempts,
      status,
      bytes,
      ttfbMs: round(ttfbMs),
      ms: round(ms),
    })),
  };
}

function readVersion() {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  return pkg.version;
}
