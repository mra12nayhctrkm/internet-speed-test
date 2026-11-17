/**
 * @typedef {Object} Summary
 * @property {number} min
 * @property {number} max
 * @property {number} mean
 * @property {number} median
 * @property {number} p95
 */

/**
 * Percentile with linear interpolation between closest ranks
 * (same method as NumPy's default and Excel's PERCENTILE.INC).
 *
 * @param {readonly number[]} sorted values sorted ascending, non-empty
 * @param {number} p percentile in [0, 100]
 */
export function percentile(sorted, p) {
  if (sorted.length === 0) throw new RangeError('percentile of an empty list');
  if (!(p >= 0 && p <= 100)) throw new RangeError('p must be within [0, 100]');
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/**
 * @param {readonly number[]} values non-empty
 * @returns {Summary}
 */
export function summarize(values) {
  if (values.length === 0) throw new RangeError('cannot summarize an empty list');
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
    median: percentile(sorted, 50),
    p95: percentile(sorted, 95),
  };
}
