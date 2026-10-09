import { describe, expect, it } from 'vitest';
import { ADC_MAX, SAMPLE_RATE_HZ, countsToMv } from '../src/core/device';
import { breathingRate, electrodeContact, heartRate, maskArtifacts, signalStatus } from '../src/core/metrics';
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

const mvToCounts = (mv: number) => mv / countsToMv(1);

/** A synthetic ECG with a lead being knocked: a 200 mV step that settles back over 0.4 s. */
function withArtifact(ecg: Float64Array, atS: number): Float64Array {
  const out = Float64Array.from(ecg);
  for (let i = 0; i < 0.4 * fs; i++) out[Math.round(atS * fs) + i] += mvToCounts(200) * (1 - i / (0.4 * fs));
  return out;
}

describe('electrodeContact', () => {
  const ecg = generate(10, (t) => syntheticEcg(t), 150);
  const resp = generate(10, (t) => syntheticResp(t), 40);

  it('reports good contact for a steady ECG and a working respiration channel', () => {
    expect(electrodeContact(ecg, resp)).toBe('stable');
  });

  it('reports electrodes off when the respiration input is pinned at full scale', () => {
    expect(electrodeContact(ecg, new Float64Array(10 * fs).fill(ADC_MAX))).toBe('off');
  });

  it('reports movement when the ECG swings far beyond any heartbeat', () => {
    expect(electrodeContact(withArtifact(ecg, 8.5), resp)).toBe('movement');
  });

  it('still works with ECG-only firmware', () => {
    expect(electrodeContact(ecg, new Float64Array(10 * fs).fill(NaN))).toBe('stable');
  });

  it('waits for data', () => {
    expect(electrodeContact(new Float64Array(0), new Float64Array(0))).toBe('no-data');
    expect(electrodeContact(ecg.subarray(0, fs), resp.subarray(0, fs))).toBe('collecting');
  });
});

describe('artefact handling', () => {
  it('masks a movement artefact but leaves heartbeats alone', () => {
    const clean = generate(10, (t) => syntheticEcg(t), 150);
    expect(maskArtifacts(clean).some(Number.isNaN)).toBe(false);
    const masked = maskArtifacts(withArtifact(clean, 5));
    expect(Number.isNaN(masked[Math.round(5.1 * fs)])).toBe(true);
    expect(Number.isNaN(masked[2 * fs])).toBe(false);
    expect(Number.isNaN(masked[8 * fs])).toBe(false);
  });

  it('recovers the heart rate 9 s after an artefact instead of waiting out the whole window', () => {
    const ecg = withArtifact(generate(20, (t) => syntheticEcg(t, 72), 150), 10.5);
    expect(heartRate(ecg).value).toBeCloseTo(72, -0.5);
    expect(heartRate(ecg.subarray(0, 14 * fs)).reason).toBe('movement artefact');
  });

  it('estimates breathing from the clean stretch after a saturated one', () => {
    const resp = generate(60, (t) => syntheticResp(t, 15), 40);
    resp.fill(ADC_MAX, 0, 20 * fs); // electrodes reattached 40 s ago
    expect(breathingRate(resp).value).toBeCloseTo(15, -0.5);
    resp.fill(ADC_MAX, 0, 40 * fs); // only 20 s since
    expect(breathingRate(resp).reason).toBe('collecting');
  });

  it('blames saturated respiration on the electrodes', () => {
    const resp = generate(60, (t) => syntheticResp(t));
    resp.fill(ADC_MAX, 55 * fs);
    expect(breathingRate(resp).reason).toMatch(/electrodes off/);
  });
});
