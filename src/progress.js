import { formatMegabytes } from './format.js';

const CLEAR_LINE = '\r\x1b[K';

/**
 * Single-line download progress for interactive terminals.
 * Redraws at most every `intervalMs` to keep terminal output cheap.
 *
 * @param {{ write(s: string): unknown }} stream
 * @param {{ now?: () => number, intervalMs?: number }} [options]
 */
export function createProgress(stream, { now = () => performance.now(), intervalMs = 100 } = {}) {
  let lastDraw = -Infinity;
  let visible = false;

  return {
    /** @param {import('./measure.js').Progress} p */
    update({ index, warmup, bytes, total }) {
      const t = now();
      if (t - lastDraw < intervalMs) return;
      lastDraw = t;
      const label = warmup ? `warm-up ${index}` : `#${index}`;
      const amount = total
        ? `${formatMegabytes(bytes)} / ${formatMegabytes(total)} (${Math.min(100, Math.floor((bytes / total) * 100))}%)`
        : formatMegabytes(bytes);
      stream.write(`${CLEAR_LINE}  ${label}  ${amount}`);
      visible = true;
    },
    /** Erase the progress line; the next update draws immediately. */
    clear() {
      if (visible) stream.write(CLEAR_LINE);
      visible = false;
      lastDraw = -Infinity;
    },
  };
}
