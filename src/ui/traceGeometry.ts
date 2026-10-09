/**
 * Pure geometry for drawing a trace: decimation to screen columns, y scaling, SVG path
 * building and tick placement. Kept free of React so it can be unit-tested.
 */
import { countsToMv } from '../core/device';
import type { SampleSeries } from '../core/series';
import { percentile } from '../core/stats';

export interface Columns {
  /** Per pixel column: lowest and highest finite value, NaN where there is no data. */
  min: Float64Array;
  max: Float64Array;
  /** Samples per column; below ~1.5 the trace is drawn sample by sample instead. */
  samplesPerColumn: number;
}

export type Units = 'counts' | 'mV';

const convert = (units: Units) => (units === 'mV' ? countsToMv : (v: number) => v);

/** Min/max per column for the samples in [startIndex, startIndex + count). */
export function decimate(series: SampleSeries, startIndex: number, count: number, columns: number, units: Units): Columns {
  const toUnits = convert(units);
  const min = new Float64Array(columns).fill(NaN);
  const max = new Float64Array(columns).fill(NaN);
  const samplesPerColumn = count / columns;
  const extent = new Float64Array(2);
  for (let c = 0; c < columns; c++) {
    const from = startIndex + Math.floor(c * samplesPerColumn);
    const to = Math.max(from + 1, startIndex + Math.floor((c + 1) * samplesPerColumn));
    if (series.extent(from, to, extent)) {
      min[c] = toUnits(extent[0]);
      max[c] = toUnits(extent[1]);
    }
  }
  return { min, max, samplesPerColumn };
}

/**
 * Robust range (1st–99th percentile of the column extremes) with 15% padding. Values for
 * which `ignore` returns true, such as samples pinned at the ADC rails, don't set the scale.
 */
export function autoRange(cols: Columns, ignore: (value: number) => boolean = () => false): [number, number] | null {
  const lows: number[] = [];
  const highs: number[] = [];
  for (let c = 0; c < cols.min.length; c++) {
    if (Number.isFinite(cols.min[c]) && !ignore(cols.min[c])) lows.push(cols.min[c]);
    if (Number.isFinite(cols.max[c]) && !ignore(cols.max[c])) highs.push(cols.max[c]);
  }
  if (lows.length === 0 || highs.length === 0) return null;
  const lo = percentile(lows, 1);
  const hi = percentile(highs, 99);
  const pad = Math.max((hi - lo) * 0.15, Math.abs(hi) * 1e-6, 1e-3);
  return [lo - pad, hi + pad];
}

/** Middle of the visible data, used to centre virtual ECG paper. */
export function centre(cols: Columns): number | null {
  const mids: number[] = [];
  for (let c = 0; c < cols.min.length; c++) {
    if (Number.isFinite(cols.min[c])) mids.push((cols.min[c] + cols.max[c]) / 2);
  }
  return mids.length ? percentile(mids, 50) : null;
}

export interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
  yMin: number;
  yMax: number;
}

const yToPx = (f: Frame, v: number) => f.y + f.height * (1 - (v - f.yMin) / (f.yMax - f.yMin));

/** SVG path through the column extremes; gaps start a new subpath. */
export function columnsPath(cols: Columns, frame: Frame): string {
  const parts: string[] = [];
  let pen = false;
  const step = frame.width / cols.min.length;
  for (let c = 0; c < cols.min.length; c++) {
    if (!Number.isFinite(cols.min[c])) {
      pen = false;
      continue;
    }
    const x = (frame.x + (c + 0.5) * step).toFixed(1);
    const y1 = yToPx(frame, cols.min[c]).toFixed(1);
    const y2 = yToPx(frame, cols.max[c]).toFixed(1);
    parts.push(`${pen ? 'L' : 'M'}${x} ${y1}`);
    if (y1 !== y2) parts.push(`L${x} ${y2}`);
    pen = true;
  }
  return parts.join('');
}

/** SVG path through individual samples, for zoomed-in views. */
export function samplesPath(
  series: SampleSeries,
  startIndex: number,
  count: number,
  frame: Frame,
  units: Units,
): string {
  const toUnits = convert(units);
  const parts: string[] = [];
  let pen = false;
  for (let i = 0; i <= count; i++) {
    const v = series.at(startIndex + i);
    if (!Number.isFinite(v)) {
      pen = false;
      continue;
    }
    const x = (frame.x + (i / count) * frame.width).toFixed(1);
    const y = yToPx(frame, toUnits(v)).toFixed(1);
    parts.push(`${pen ? 'L' : 'M'}${x} ${y}`);
    pen = true;
  }
  return parts.join('');
}

/** Evenly spaced "nice" values (1, 2, 5 × 10^k) covering [min, max]. */
export function niceTicks(min: number, max: number, target = 5): number[] {
  if (!(max > min)) return [];
  const raw = (max - min) / target;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const steps = [1, 2, 5, 10].map((m) => m * magnitude);
  const step = steps.reduce((best, s) => (Math.abs((max - min) / s - target) < Math.abs((max - min) / best - target) ? s : best));
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  const ticks: number[] = [];
  for (let k = Math.ceil(min / step - 1e-9); k * step <= max + step * 1e-9; k++) {
    ticks.push(Number((k * step).toFixed(decimals)) + 0);
  }
  return ticks;
}

/** Human-readable length, e.g. "42 s" or "12:05". */
export function formatDuration(seconds: number): string {
  return seconds < 60 ? `${Math.round(seconds)} s` : formatTime(seconds, seconds);
}

export function formatTime(seconds: number, spanSeconds: number): string {
  if (seconds < 0) return `−${formatTime(-seconds, spanSeconds)}`;
  if (spanSeconds >= 60) {
    const s = Math.round(seconds);
    const m = Math.floor(s / 60);
    return `${m}:${String(s - m * 60).padStart(2, '0')}`;
  }
  return spanSeconds < 5 ? seconds.toFixed(1) : String(Math.round(seconds));
}

function groupThousands(n: number): string {
  const digits = String(Math.abs(Math.round(n)));
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return n < 0 ? `-${grouped}` : grouped;
}

/** Tick label with just enough precision to tell neighbouring ticks (`step` apart) apart. */
export function formatValue(value: number, units: Units, step: number): string {
  if (units === 'mV') return value.toFixed(Math.max(0, Math.min(3, -Math.floor(Math.log10(step)))));
  if (step >= 1e3 && Math.abs(value) < 1e6) return `${(value / 1e3).toFixed(step % 1e3 === 0 ? 0 : 1)}k`;
  return groupThousands(value);
}

/** One SVG path of evenly spaced vertical and horizontal lines. */
export function gridPath(frame: Frame, xStepPx: number, yStepPx: number, xOffsetPx = 0, yOffsetPx = 0): string {
  const parts: string[] = [];
  const right = frame.x + frame.width;
  const bottom = frame.y + frame.height;
  if (xStepPx >= 2) {
    for (let x = frame.x + (xOffsetPx % xStepPx); x <= right + 0.01; x += xStepPx) {
      parts.push(`M${x.toFixed(1)} ${frame.y}V${bottom}`);
    }
  }
  if (yStepPx >= 2) {
    for (let y = frame.y + (yOffsetPx % yStepPx); y <= bottom + 0.01; y += yStepPx) {
      parts.push(`M${frame.x} ${y.toFixed(1)}H${right}`);
    }
  }
  return parts.join('');
}
