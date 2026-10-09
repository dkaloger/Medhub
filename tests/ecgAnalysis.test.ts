import { describe, expect, it } from 'vitest';
import { analyseEcg, detectBeats } from '../src/core/ecgAnalysis';
import { SAMPLE_RATE_HZ } from '../src/core/device';
import { NORMAL_BEAT, noiseGenerator, renderBeats, type BeatShape } from '../src/core/synthetic';

const fs = SAMPLE_RATE_HZ;
const DURATION = 120;

function ecg(beats: number[], shape: BeatShape = NORMAL_BEAT, noise = 150): Float64Array {
  const rand = noiseGenerator(5);
  return renderBeats(beats, DURATION, fs, shape).map((v) => v + noise * rand());
}

/** Beat times with respiratory sinus arrhythmia: RR swings ±`swing` around `rr` at 0.25 Hz. */
function sinusBeats(rr: number, swing = 0): number[] {
  const beats = [0.5];
  while (beats[beats.length - 1] < DURATION - 1.5) {
    const t = beats[beats.length - 1];
    beats.push(t + rr * (1 + swing * Math.sin(2 * Math.PI * 0.25 * t)));
  }
  return beats;
}

function truthVariation(beats: number[]) {
  const rr = beats.slice(1).map((t, i) => (t - beats[i]) * 1000);
  const m = rr.reduce((a, b) => a + b) / rr.length;
  const sdnn = Math.sqrt(rr.reduce((a, b) => a + (b - m) ** 2, 0) / rr.length);
  const d = rr.slice(1).map((v, i) => v - rr[i]);
  return { sdnn, rmssd: Math.sqrt(d.reduce((a, b) => a + b * b, 0) / d.length) };
}

describe('beat detection', () => {
  it('finds every R peak within 8 ms, whichever way the QRS points', () => {
    const truth = sinusBeats(0.8, 0.05);
    for (const sign of [1, -1]) {
      const { beats, polarity } = detectBeats(ecg(truth).map((v) => sign * v));
      expect(polarity).toBe(sign);
      expect(beats.length).toBe(truth.length);
      beats.forEach((b, i) => expect(Math.abs(b / fs - truth[i])).toBeLessThan(0.008));
    }
  });

  it('never measures an interval across a gap', () => {
    const signal = ecg(sinusBeats(0.8));
    signal.fill(NaN, 60 * fs, 63 * fs);
    const a = analyseEcg(signal);
    expect(a.intervals.every((iv) => iv.rr < 1.2)).toBe(true);
  });
});

describe('rhythm', () => {
  it.each([
    [1.2, 'slow'],
    [0.8, 'normal'],
    [0.5, 'fast'],
  ] as const)('describes a regular rhythm at RR %s s as %s rate', (rr, rate) => {
    const { rhythm } = analyseEcg(ecg(sinusBeats(rr, 0.03)));
    expect(rhythm.pattern).toBe('regular');
    expect(rhythm.rate).toBe(rate);
  });

  it('does not mistake breathing-related variation for an irregular rhythm', () => {
    expect(analyseEcg(ecg(sinusBeats(0.85, 0.08))).rhythm.pattern).toBe('regular');
  });

  it('counts premature beats', () => {
    const beats = sinusBeats(0.8);
    for (const k of [40, 80, 120]) beats[k] -= 0.3; // early beat, then a compensatory pause
    const { rhythm } = analyseEcg(ecg(beats));
    expect(rhythm.premature).toBe(3);
    expect(rhythm.findings.join(' ')).toMatch(/3 early beats/);
  });

  it('reports pauses', () => {
    const beats = sinusBeats(0.8).filter((_, i) => i !== 60 && i !== 61);
    const { rhythm } = analyseEcg(ecg(beats));
    expect(rhythm.pauses).toBe(1);
  });

  it('flags chaotic beat timing without P waves', () => {
    const rand = noiseGenerator(9);
    const beats = [0.5];
    while (beats[beats.length - 1] < DURATION - 1.5) beats.push(beats[beats.length - 1] + 0.45 + 0.3 * (rand() + 1));
    const a = analyseEcg(ecg(beats, { ...NORMAL_BEAT, pAmplitude: 0 }));
    expect(a.rhythm.pattern).toBe('irregularly-irregular');
    expect(a.rhythm.findings[0]).toMatch(/cannot diagnose/);
  });

  it('waits for enough signal', () => {
    const short = ecg(sinusBeats(0.8)).subarray(0, 20 * fs);
    expect(analyseEcg(short).rhythm.pattern).toBe('insufficient');
  });
});

describe('beat-to-beat variation', () => {
  it('matches SDNN and RMSSD computed from the true beat times', () => {
    const beats = sinusBeats(0.85, 0.06);
    const { variation } = analyseEcg(ecg(beats));
    const truth = truthVariation(beats);
    expect(variation!.sdnn).toBeCloseTo(truth.sdnn, -0.5);
    expect(variation!.rmssd).toBeCloseTo(truth.rmssd, -0.5);
    expect(variation!.meanHR).toBeCloseTo(60 / 0.85, -0.5);
  });

  it('leaves premature beats out of the variation statistics', () => {
    const regular = sinusBeats(0.8);
    const withEctopy = [...regular];
    for (const k of [30, 70, 110]) withEctopy[k] -= 0.3;
    const clean = analyseEcg(ecg(regular)).variation!;
    const ectopic = analyseEcg(ecg(withEctopy)).variation!;
    expect(ectopic.sdnn).toBeLessThan(clean.sdnn + 5);
  });
});

describe('median beat intervals', () => {
  const measure = (shape: BeatShape, rr = 0.8) => analyseEcg(ecg(sinusBeats(rr), shape)).medianBeat!.intervals;

  it('measures plausible PR, QRS and QT on a normal synthetic beat', () => {
    const iv = measure(NORMAL_BEAT);
    expect(iv.pr).toBeGreaterThan(180);
    expect(iv.pr).toBeLessThan(260);
    expect(iv.qrs).toBeGreaterThan(70);
    expect(iv.qrs).toBeLessThan(110);
    expect(iv.qt).toBeGreaterThan(330);
    expect(iv.qt).toBeLessThan(420);
    expect(iv.qtcBazett).toBeCloseTo(iv.qt! / Math.sqrt(0.8), -1);
  });

  it.each([0.8, 1.2])('tracks a longer QT, PR and QRS at RR %s s', (rr) => {
    const base = measure(NORMAL_BEAT, rr);
    expect(measure({ ...NORMAL_BEAT, tOffset: 0.26 }, rr).qt! - base.qt!).toBeGreaterThan(45);
    expect(measure({ ...NORMAL_BEAT, pOffset: -0.24 }, rr).pr! - base.pr!).toBeGreaterThan(30);
    expect(measure({ ...NORMAL_BEAT, qrsWidth: 1.6 }, rr).qrs! - base.qrs!).toBeGreaterThan(35);
  });

  it('reports no PR when there is no P wave rather than inventing one', () => {
    const a = analyseEcg(ecg(sinusBeats(0.8), { ...NORMAL_BEAT, pAmplitude: 0 }));
    expect(a.medianBeat!.intervals.pr).toBeNull();
    expect(a.rhythm.findings.join(' ')).toMatch(/No clear P wave/);
  });

  it('declines to measure PR and QT where T and P waves merge at fast rates', () => {
    const iv = measure(NORMAL_BEAT, 0.5);
    expect(iv.pr).toBeNull();
    expect(iv.qrs).not.toBeNull();
  });
});
