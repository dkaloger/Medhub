/** Peak picking with the same semantics as scipy.signal.find_peaks for the options used here. */

export interface PeakOptions {
  /** Minimum peak value. */
  height?: number;
  /** Minimum spacing in samples; taller peaks win. */
  distance?: number;
  /** Minimum prominence (height above the higher of the two surrounding minima). */
  prominence?: number;
}

export interface Peaks {
  indices: number[];
  prominences: number[];
}

function localMaxima(x: ArrayLike<number>): number[] {
  const peaks: number[] = [];
  let i = 1;
  const last = x.length - 1;
  while (i < last) {
    if (x[i - 1] < x[i]) {
      let ahead = i + 1;
      while (ahead < last && x[ahead] === x[i]) ahead++;
      if (x[ahead] < x[i]) {
        peaks.push(Math.floor((i + ahead - 1) / 2));
        i = ahead;
      }
    }
    i++;
  }
  return peaks;
}

function byDistance(x: ArrayLike<number>, peaks: number[], distance: number): number[] {
  const keep = new Array<boolean>(peaks.length).fill(true);
  const order = peaks.map((_, j) => j).sort((a, b) => x[peaks[b]] - x[peaks[a]] || b - a);
  for (const j of order) {
    if (!keep[j]) continue;
    for (let k = j - 1; k >= 0 && peaks[j] - peaks[k] < distance; k--) keep[k] = false;
    for (let k = j + 1; k < peaks.length && peaks[k] - peaks[j] < distance; k++) keep[k] = false;
  }
  return peaks.filter((_, j) => keep[j]);
}

function prominence(x: ArrayLike<number>, peak: number): number {
  const top = x[peak];
  let leftMin = top;
  for (let i = peak; i >= 0 && x[i] <= top; i--) leftMin = Math.min(leftMin, x[i]);
  let rightMin = top;
  for (let i = peak; i < x.length && x[i] <= top; i++) rightMin = Math.min(rightMin, x[i]);
  return top - Math.max(leftMin, rightMin);
}

export function findPeaks(x: ArrayLike<number>, options: PeakOptions = {}): Peaks {
  let peaks = localMaxima(x);
  if (options.height !== undefined) {
    const height = options.height;
    peaks = peaks.filter((p) => x[p] >= height);
  }
  if (options.distance !== undefined && options.distance > 1) {
    peaks = byDistance(x, peaks, Math.ceil(options.distance));
  }
  let prominences = peaks.map((p) => prominence(x, p));
  if (options.prominence !== undefined) {
    const min = options.prominence;
    const kept = peaks.map((_, j) => j).filter((j) => prominences[j] >= min);
    peaks = kept.map((j) => peaks[j]);
    prominences = kept.map((j) => prominences[j]);
  }
  return { indices: peaks, prominences };
}
