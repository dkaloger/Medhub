import { describe, expect, it } from 'vitest';
import { ArraySeries } from '../src/core/series';
import { autoRange, columnsPath, decimate, formatTime, formatValue, gridPath, niceTicks } from '../src/ui/traceGeometry';

const frame = { x: 0, y: 0, width: 4, height: 10, yMin: 0, yMax: 10 };

describe('decimate', () => {
  it('keeps the extremes of each column so narrow QRS spikes survive', () => {
    const series = new ArraySeries(Float64Array.from([1, 9, 2, 2, 3, 3, 4, 0]));
    const cols = decimate(series, 0, 8, 4, 'counts');
    expect(Array.from(cols.min)).toEqual([1, 2, 3, 0]);
    expect(Array.from(cols.max)).toEqual([9, 2, 3, 4]);
  });

  it('leaves gaps empty and handles data outside the series', () => {
    const series = new ArraySeries(Float64Array.from([5, NaN, NaN, 6]), 10);
    const cols = decimate(series, 8, 6, 3, 'counts');
    expect(Array.from(cols.min)).toEqual([NaN, 5, 6]);
  });
});

describe('paths', () => {
  it('breaks the line at gaps', () => {
    const cols = { min: Float64Array.from([0, NaN, 10]), max: Float64Array.from([5, NaN, 10]), samplesPerColumn: 1 };
    expect(columnsPath(cols, { ...frame, width: 3 })).toBe('M0.5 10.0L0.5 5.0M2.5 0.0');
  });

  it('draws evenly spaced grid lines', () => {
    expect(gridPath(frame, 2, 5)).toBe('M0.0 0V10M2.0 0V10M4.0 0V10M0 0.0H4M0 5.0H4M0 10.0H4');
  });
});

describe('scales and labels', () => {
  it('ignores single-sample spikes when autoscaling', () => {
    const min = new Float64Array(200).fill(0);
    const max = new Float64Array(200).fill(10);
    max[50] = 1e6;
    const [lo, hi] = autoRange({ min, max, samplesPerColumn: 1 })!;
    expect(hi).toBeLessThan(20);
    expect(lo).toBeLessThan(0);
  });

  it('picks round tick values', () => {
    expect(niceTicks(0, 10)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(niceTicks(-0.73, 0.41, 4)).toEqual([-0.6, -0.4, -0.2, 0, 0.2, 0.4]);
  });

  it('labels ticks precisely enough to tell them apart', () => {
    expect([999_500, 1_000_000, 1_000_500].map((v) => formatValue(v, 'counts', 500))).toEqual(['999,500', '1,000,000', '1,000,500']);
    expect(formatValue(-5000, 'counts', 5000)).toBe('-5k');
    expect(formatValue(0.25, 'mV', 0.05)).toBe('0.25');
  });

  it('formats session time', () => {
    expect(formatTime(125, 120)).toBe('2:05');
    expect(formatTime(12.34, 2)).toBe('12.3');
  });
});
