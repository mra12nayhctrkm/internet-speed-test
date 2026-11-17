const MB = 1_000_000; // decimal, matches how ISPs quote speeds

/**
 * Bytes → "1.23 MB" (decimal megabytes).
 * @param {number} bytes
 */
export function formatMegabytes(bytes) {
  return `${(bytes / MB).toFixed(2)} MB`;
}

/**
 * Bytes per second → megabits per second (1 Mbit = 1,000,000 bits).
 * @param {number} bytesPerSecond
 */
export function toMbit(bytesPerSecond) {
  return (bytesPerSecond * 8) / MB;
}

/**
 * Bytes per second → "12.34 Mbit/s".
 * @param {number} bytesPerSecond
 */
export function formatMbit(bytesPerSecond) {
  return `${toMbit(bytesPerSecond).toFixed(2)} Mbit/s`;
}

/**
 * Bytes per second → "1.54 MB/s".
 * @param {number} bytesPerSecond
 */
export function formatMBps(bytesPerSecond) {
  return `${(bytesPerSecond / MB).toFixed(2)} MB/s`;
}

/**
 * Milliseconds → "123.4 ms".
 * @param {number} ms
 */
export function formatMs(ms) {
  return `${ms.toFixed(1)} ms`;
}
