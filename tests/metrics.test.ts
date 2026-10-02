import { describe, expect, it } from 'vitest';
import { ADC_MAX, SAMPLE_RATE_HZ } from '../src/core/device';
import { breathingRate, heartRate, signalStatus } from '../src/core/metrics';
import { noiseGenerator, syntheticEcg, syntheticResp } from '../src/core/synthetic';

const fs = SAMPLE_RATE_HZ;

function generate(seconds: number, f: (t: number) => number, noise = 0, seed = 3): Float64Array {
  const rand = noiseGenerator(seed);
  return Float64Array.from({ length: seconds * fs }, (_, i) => f(i / fs) + noise * rand());
}

describe('heartRate', () => {
  it.each([45, 72, 110, 160])('finds %i bpm in a synthetic ECG with P and T waves and noise', (bpm) => {
    const ecg = generate(20, (t) => syntheticEcg(t, bpm), 400);
    expect(heartRate(ecg).value).toBeCloseTo(bpm, -0.5);
  });

  it('does not depend on QRS polarity', () => {
    const ecg = generate(20, (t) => -syntheticEcg(t, 72));
    expect(heartRate(ecg).value).toBeCloseTo(72, -0.5);
  });

  it('waits for enough data', () => {
    expect(heartRate(generate(5, (t) => syntheticEcg(t)))).toEqual({ value: null, reason: 'collecting' });
  });

  it('gives no rate for flat, clipped, or pure-noise input', () => {
    expect(heartRate(new Float64Array(20 * fs)).value).toBeNull();
    expect(heartRate(new Float64Array(20 * fs).fill(ADC_MAX)).reason).toBe('ADC clipped');
    expect(heartRate(generate(20, () => 0, 3000)).value).toBeNull();
  });

  it('only uses data after the most recent gap', () => {
    const ecg = generate(30, (t) => syntheticEcg(t, 72));
    ecg.fill(NaN, ecg.length - 5 * fs, ecg.length - 4 * fs);
    expect(heartRate(ecg).reason).toBe('collecting');
  });
});

describe('breathingRate', () => {
  it.each([8, 15, 30])('finds %i breaths/min', (rate) => {
    const resp = generate(60, (t) => syntheticResp(t, rate), 50);
    expect(breathingRate(resp).value).toBeCloseTo(rate, -0.5);
  });

  it('waits for 25 s of data and rejects flat input', () => {
    expect(breathingRate(generate(20, (t) => syntheticResp(t))).reason).toBe('collecting');
    expect(breathingRate(new Float64Array(60 * fs).fill(1_000_000)).value).toBeNull();
  });
});

describe('signalStatus', () => {
  it('classifies obvious failures', () => {
    expect(signalStatus(new Float64Array(0))).toBe('no-data');
    expect(signalStatus(new Float64Array(fs).fill(NaN))).toBe('no-data');
    expect(signalStatus(new Float64Array(fs))).toBe('collecting');
    expect(signalStatus(new Float64Array(6 * fs).fill(ADC_MAX))).toBe('clipped');
    expect(signalStatus(new Float64Array(6 * fs).fill(-(2 ** 23)))).toBe('clipped');
    expect(signalStatus(new Float64Array(6 * fs))).toBe('flat');
    expect(signalStatus(generate(6, (t) => syntheticEcg(t)))).toBe('ok');
  });
});
