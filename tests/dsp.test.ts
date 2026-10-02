import { describe, expect, it } from 'vitest';
import scipy from './fixtures/scipy.json';
import { FilterChain, bandpass, filtfilt, highpass, lowpass, notch, type Biquad } from '../src/core/filters';
import { findPeaks } from '../src/core/peaks';

const signal = Float64Array.from(scipy.signal);

function expectClose(actual: ArrayLike<number>, expected: ArrayLike<number>, tolerance: number) {
  expect(actual.length).toBe(expected.length);
  let worst = 0;
  for (let i = 0; i < actual.length; i++) worst = Math.max(worst, Math.abs(actual[i] - expected[i]));
  expect(worst).toBeLessThan(tolerance);
}

describe('filter design matches scipy.signal', () => {
  it.each([
    ['butter(2, 40, low)', lowpass(40), scipy.lowpass40[0]],
    ['butter(2, 0.5, high)', highpass(0.5), scipy.highpass05[0]],
    ['iirnotch(50, 30)', notch(50), scipy.notch50[0]],
  ])('%s', (_name, ours, reference) => {
    expectClose(ours as Biquad, reference, 1e-12);
  });
});

describe('FilterChain', () => {
  const sections = bandpass(0.5, 40);

  it('matches sosfilt with steady-state initial conditions', () => {
    expectClose(new FilterChain(sections).process(signal), scipy.bandSosfilt, 1e-6);
  });

  it('gives identical output whether fed in one piece or in chunks', () => {
    const whole = new FilterChain(sections).process(signal);
    const chunked = new FilterChain(sections);
    const pieces: number[] = [];
    for (let i = 0; i < signal.length; i += 37) pieces.push(...chunked.process(signal.subarray(i, i + 37)));
    expectClose(pieces, whole, 1e-9);
  });

  it('starts at steady state, so a large DC offset does not ring', () => {
    const out = new FilterChain([lowpass(2)]).process(new Float64Array(500).fill(1_000_000));
    expectClose(out, new Float64Array(500).fill(1_000_000), 1e-6);
    const hp = new FilterChain(sections).process(new Float64Array(500).fill(-700_000));
    expectClose(hp, new Float64Array(500), 1e-6);
  });

  it('passes gaps through as NaN and restarts cleanly afterwards', () => {
    const input = new Float64Array(400).fill(5000);
    input.fill(NaN, 100, 120);
    input.fill(9000, 120);
    const out = new FilterChain([lowpass(2)]).process(input);
    expect(out.slice(100, 120).every(Number.isNaN)).toBe(true);
    expect(out[120]).toBeCloseTo(9000, 6);
    expect(out[399]).toBeCloseTo(9000, 6);
  });

  it('is a passthrough with no sections', () => {
    expect(Array.from(new FilterChain().process([1, 2, 3]))).toEqual([1, 2, 3]);
  });
});

describe('filtfilt matches scipy.signal.sosfiltfilt', () => {
  it('band-pass', () => expectClose(filtfilt(bandpass(0.5, 40), signal), scipy.bandFiltfilt, 1e-5));
  it('notch', () => expectClose(filtfilt([notch(50)], signal), scipy.notchFiltfilt, 1e-5));
});

describe('findPeaks matches scipy.signal.find_peaks', () => {
  it('height + distance + prominence', () => {
    const x = Float64Array.from(scipy.peaksInput);
    const sorted = Float64Array.from(x).sort();
    const rank = 0.4 * (sorted.length - 1);
    const height = sorted[Math.floor(rank)] + (sorted[Math.ceil(rank)] - sorted[Math.floor(rank)]) * (rank % 1);
    const { indices, prominences } = findPeaks(x, { height, distance: 12, prominence: 1.5 });
    expect(indices).toEqual(scipy.peaks);
    expectClose(prominences, scipy.prominences, 1e-9);
  });

  it('reports the middle of a flat-topped peak', () => {
    expect(findPeaks([0, 1, 3, 3, 3, 1, 0]).indices).toEqual([3]);
  });
});
