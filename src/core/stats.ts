/** Small numeric helpers over typed arrays. Inputs are assumed finite unless noted. */

export function percentile(values: ArrayLike<number>, p: number): number {
  if (values.length === 0) return NaN;
  const sorted = Float64Array.from(values).sort();
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

export function median(values: ArrayLike<number>): number {
  return percentile(values, 50);
}

export function mean(values: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i];
  return sum / values.length;
}

export function std(values: ArrayLike<number>): number {
  const m = mean(values);
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += (values[i] - m) ** 2;
  return Math.sqrt(sum / values.length);
}

export function peakToPeak(values: ArrayLike<number>): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < values.length; i++) {
    if (values[i] < lo) lo = values[i];
    if (values[i] > hi) hi = values[i];
  }
  return values.length ? hi - lo : 0;
}

/** Centred moving average with a window of `width` samples (edges use a partial window). */
export function movingAverage(values: ArrayLike<number>, width: number): Float64Array {
  const n = values.length;
  const out = new Float64Array(n);
  const half = Math.floor(width / 2);
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + values[i];
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n, i - half + width);
    out[i] = (prefix[hi] - prefix[lo]) / (hi - lo);
  }
  return out;
}

/** The newest run of finite samples, i.e. everything after the last gap. */
export function trailingFinite(values: Float64Array): Float64Array {
  let start = values.length;
  while (start > 0 && Number.isFinite(values[start - 1])) start--;
  return values.subarray(start);
}
