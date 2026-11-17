import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { run } from '../src/cli.js';
import { createSink, startServer } from './helpers.js';

const exec = promisify(execFile);
const bin = fileURLToPath(new URL('../bin/speedtest.js', import.meta.url));
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const body = Buffer.alloc(100_000, 'y');

/**
 * @param {string[]} args
 * @param {{ fetchImpl?: typeof fetch, tty?: boolean }} [options]
 */
async function runCli(args, { fetchImpl, tty = false } = {}) {
  const stdout = createSink();
  const stderr = Object.assign(createSink(), { isTTY: tty });
  const code = await run(args, { stdout, stderr, fetchImpl, retryDelayMs: 0 });
  return { code, out: stdout.text, err: stderr.text };
}

/** Run `fn` against a server that always answers with `body`. */
async function withServer(/** @type {(url: string) => Promise<void>} */ fn) {
  const server = await startServer((_req, res) => res.end(body));
  try {
    await fn(server.url);
  } finally {
    await server.close();
  }
}

test('prints per-request lines and a summary with units', () =>
  withServer(async (url) => {
    const { code, out, err } = await runCli([url]);
    assert.equal(code, 0);
    assert.equal(err, '');
    assert.equal(out.match(/^ {2}#/gm)?.length, 10);
    assert.match(out, /Requests: {7}10/);
    assert.match(out, /Total data: {5}1\.00 MB/);
    assert.match(out, /Average time: {3}\d+\.\d ms per request/);
    assert.match(out, /Time, ms: {7}min [\d.]+ · median [\d.]+ · p95 [\d.]+ · max [\d.]+/);
    assert.match(out, /TTFB, ms: {7}min /);
    assert.match(out, /Download speed: \d+\.\d{2} Mbit\/s \(\d+\.\d{2} MB\/s\)/);
  }));

test('--requests and --warmup', () =>
  withServer(async (url) => {
    const { code, out } = await runCli([url, '-n', '3', '--warmup', '2']);
    assert.equal(code, 0);
    assert.match(out, /Warm-up: 2 \(not counted\)/);
    assert.equal(out.match(/^ {2}warm-up/gm)?.length, 2);
    assert.equal(out.match(/^ {2}#/gm)?.length, 3);
    assert.match(out, /Requests: {7}3/);
    assert.match(out, /Total data: {5}0\.30 MB/);
  }));

test('--json prints machine-readable output only', () =>
  withServer(async (url) => {
    const { code, out, err } = await runCli([url, '--json', '-n', '2']);
    assert.equal(code, 0);
    assert.equal(err, '');
    const data = JSON.parse(out);
    assert.equal(data.requests, 2);
    assert.equal(data.totalBytes, 200_000);
    assert.equal(data.samples.length, 2);
    assert.ok(Math.abs(data.mbitPerSecond - (data.bytesPerSecond * 8) / 1e6) < 0.001);
    assert.deepEqual(Object.keys(data.timeMs).sort(), ['max', 'mean', 'median', 'min', 'p95']);
    // Values are rounded to at most 3 decimals.
    for (const v of [data.totalMs, data.avgMs, ...Object.values(data.timeMs), data.samples[0].ms]) {
      assert.equal(v, Math.round(v * 1000) / 1000);
    }
    assert.ok(Number.isInteger(data.bytesPerSecond));
  }));

test('--retries recovers from a transient failure and shows the attempt', async () => {
  let calls = 0;
  const fetchImpl = async () =>
    new Response(++calls === 1 ? 'x' : 'ok', {
      status: calls === 1 ? 503 : 200,
    });
  const { code, out } = await runCli(['http://x.test/', '-n', '1', '-r', '1'], { fetchImpl });
  assert.equal(code, 0);
  assert.match(out, /\(attempt 2\)/);
});

test('shows a progress line on a TTY and erases it', () =>
  withServer(async (url) => {
    const { code, out, err } = await runCli([url, '-n', '1'], { tty: true });
    assert.equal(code, 0);
    const CLEAR = '\r\x1b[K';
    assert.ok(err.startsWith(`${CLEAR}  #1  `), 'progress line is drawn');
    assert.ok(err.endsWith(CLEAR), 'progress line is cleared');
    assert.ok(!out.includes('\x1b'), 'stdout stays clean');
  }));

test('no progress on a TTY in --json mode', () =>
  withServer(async (url) => {
    const { err } = await runCli([url, '-n', '1', '--json'], { tty: true });
    assert.equal(err, '');
  }));

test('--help and --version exit 0', async () => {
  const help = await runCli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /Usage: speedtest/);

  const version = await runCli(['-V']);
  assert.equal(version.code, 0);
  assert.equal(version.out, `${pkg.version}\n`);
});

test('usage errors exit with code 2 and write nothing to stdout', async () => {
  for (const args of [
    [],
    ['a', 'b'],
    ['http://x.test', '-n', '0'],
    ['http://x.test', '-n', 'abc'],
    ['http://x.test', '-n', '1.5'],
    ['http://x.test', '-n', ''],
    ['http://x.test', '-w', '-1'],
    ['http://x.test', '-r', 'x'],
    ['http://x.test', '-t', '-5'],
    ['http://x.test', '-t', 'abc'],
    ['http://x.test', '--bogus'],
    ['not a url'],
    ['ftp://x.test/file'],
  ]) {
    const { code, out, err } = await runCli(args);
    assert.equal(code, 2, `args: ${JSON.stringify(args)}`);
    assert.match(err, /^Error: /);
    assert.equal(out, '');
  }
});

test('runtime failure exits with code 1 and a message on stderr', async () => {
  const server = await startServer((_req, res) => res.writeHead(503).end());
  try {
    const { code, err } = await runCli([server.url]);
    assert.equal(code, 1);
    assert.match(err, /Error: Request 1\/10 failed: HTTP 503/);
  } finally {
    await server.close();
  }
});

test('real binary: works end to end and propagates exit codes', () =>
  withServer(async (url) => {
    const ok = await exec(process.execPath, [bin, url, '-n', '2']);
    assert.match(ok.stdout, /Download speed:/);

    await assert.rejects(exec(process.execPath, [bin]), { code: 2 });
    await assert.rejects(exec(process.execPath, [bin, 'http://127.0.0.1:1/']), { code: 1 });
  }));
