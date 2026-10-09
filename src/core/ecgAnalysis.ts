/**
 * Beat-level ECG analysis: R-peak detection, rhythm description, beat-to-beat variation
 * (HRV) and interval measurement on a median beat.
 *
 * EXPERIMENTAL AND NOT DIAGNOSTIC. Single-lead bench signals cannot support a clinical
 * interpretation; these are descriptive measurements meant to be checked against the trace.
 */
import { SAMPLE_RATE_HZ, countsToMv, isClipped } from './device';
import { bandpass, filtfilt } from './filters';
import { maskArtifacts } from './metrics';
import { findPeaks } from './peaks';
import { mean, median, movingAverage, percentile, std } from './stats';

export const ANALYSIS = {
  /** Window analysed for rhythm and variation. */
  windowS: 120,
  /** Shortest gap-free stretch worth searching for beats. */
  minRunS: 4,
  /** Rhythm needs at least this much beat data. */
  minAnalysedS: 30,
  minBeats: 20,
  refractoryS: 0.25,
  /** An interval this far from its neighbours' median is premature, delayed or spurious. */
  ectopicTolerance: 0.2,
  pauseS: 2,
  /** Beats averaged into the median beat. */
  templateBeats: 40,
  templatePreS: 0.35,
  /**
   * QRS boundaries: "sloped" and "flat" as fractions of the steepest QRS slope. Tuned so
   * synthetic beats of known width (~95 and ~152 ms) measure within ~5 ms.
   */
  qrsSteep: 0.08,
  qrsFlat: 0.04,
  /** How far beyond the last sloped sample the boundary may be. */
  qrsSettleMs: 40,
};

/** Typical resting adult reference ranges, shown for context only. */
export const REFERENCE = {
  heartRate: [60, 100],
  pr: [120, 200],
  qrs: [70, 110],
  qtc: [350, 460],
} as const;

export interface BeatDetection {
  /** R-peak sample indices into the analysed array, ascending. */
  beats: number[];
  /** Index of the gap-free stretch each beat belongs to; intervals never cross stretches. */
  run: number[];
  /** Direction of the dominant QRS deflection in this lead. */
  polarity: 1 | -1;
  /** Seconds of signal actually searched (gaps, clipping and artefacts excluded). */
  analysedS: number;
}

export interface Interval {
  /** Time of the beat ending the interval, in seconds from the start of the window. */
  t: number;
  rr: number;
  kind: 'normal' | 'premature' | 'delayed';
}

export interface Variation {
  beats: number;
  meanRR: number;
  meanHR: number;
  minHR: number;
  maxHR: number;
  /** ms */
  sdnn: number;
  /** ms */
  rmssd: number;
  /** % */
  pnn50: number;
  /** Poincaré plot axes, ms */
  sd1: number;
  sd2: number;
}

export type RhythmPattern = 'insufficient' | 'regular' | 'irregular' | 'irregularly-irregular';

export interface Rhythm {
  pattern: RhythmPattern;
  rate: 'slow' | 'normal' | 'fast' | null;
  /** Short description, e.g. "Regular rhythm, normal rate". */
  summary: string;
  /** Extra observations worth a look, e.g. premature beats or pauses. */
  findings: string[];
  premature: number;
  pauses: number;
}

export interface Fiducials {
  /** Sample offsets within the template; null where a wave was not found. */
  pOnset: number | null;
  pPeak: number | null;
  qrsOnset: number;
  r: number;
  qrsOffset: number;
  tPeak: number | null;
  tEnd: number | null;
}

export interface Intervals {
  /** ms; null when the waves needed could not be found reliably. */
  pr: number | null;
  qrs: number | null;
  qt: number | null;
  qtcBazett: number | null;
  qtcFridericia: number | null;
}

export interface MedianBeat {
  /** Band-passed (0.5–40 Hz) median of recent normal beats, in mV. */
  waveform: Float64Array;
  fiducials: Fiducials;
  intervals: Intervals;
  beatsAveraged: number;
}

export interface EcgAnalysis {
  windowS: number;
  detection: BeatDetection;
  intervals: Interval[];
  rhythm: Rhythm;
  variation: Variation | null;
  medianBeat: MedianBeat | null;
}

// ---------------------------------------------------------------------------------------
// Beat detection

function finiteRuns(values: Float64Array, minLength: number): [number, number][] {
  const runs: [number, number][] = [];
  let start = -1;
  for (let i = 0; i <= values.length; i++) {
    const ok = i < values.length && Number.isFinite(values[i]);
    if (ok && start < 0) start = i;
    if (!ok && start >= 0) {
      if (i - start >= minLength) runs.push([start, i]);
      start = -1;
    }
  }
  return runs;
}

/** Gaps, clipped samples and movement artefacts become NaN so detection never spans them. */
function usable(counts: Float64Array, fs: number): Float64Array {
  const out = counts.map((v) => (isClipped(v) ? NaN : v));
  for (const [a, b] of finiteRuns(out, 2)) out.set(maskArtifacts(out.subarray(a, b), fs), a);
  return out;
}

/** QRS detection on band-passed slope energy, then each beat placed on the R peak itself. */
export function detectBeats(counts: Float64Array, fs = SAMPLE_RATE_HZ): BeatDetection {
  const clean = usable(counts, fs);
  // For each detected QRS: the highest and lowest point nearby, and which one dominates.
  const found: { run: number; up: number; down: number; upDominant: boolean }[] = [];
  let analysed = 0;
  const runs = finiteRuns(clean, Math.round(ANALYSIS.minRunS * fs));
  runs.forEach(([a, b], runIndex) => {
    const x = clean.subarray(a, b);
    const m = median(x);
    const centred = x.map((v) => v - m);
    const band = filtfilt(bandpass(5, 25, fs), centred);
    const slope = new Float64Array(band.length);
    for (let i = 1; i < band.length; i++) slope[i] = (band[i] - band[i - 1]) ** 2;
    const energy = movingAverage(slope, Math.round(0.1 * fs));
    const candidates = findPeaks(energy, { distance: 0.3 * fs }).indices;
    if (candidates.length < 3) return;
    const threshold = 0.3 * percentile(candidates.map((i) => energy[i]), 75);
    const beats = candidates.filter((i) => energy[i] >= threshold);
    if (!(median(beats.map((i) => energy[i])) / median(energy) >= 8)) return; // noise, not beats
    analysed += b - a;
    const display = filtfilt(bandpass(0.5, 40, fs), centred);
    const search = Math.round(0.08 * fs);
    for (const i of beats) {
      let up = i;
      let down = i;
      for (let k = Math.max(0, i - search); k <= Math.min(display.length - 1, i + search); k++) {
        if (display[k] > display[up]) up = k;
        if (display[k] < display[down]) down = k;
      }
      found.push({ run: runIndex, up: a + up, down: a + down, upDominant: display[up] >= -display[down] });
    }
  });

  // The lead's polarity is whichever deflection dominates across all beats; every beat is
  // then placed on that deflection so intervals are measured peak to peak consistently.
  const upVotes = found.filter((f) => f.upDominant).length;
  const polarity: 1 | -1 = upVotes >= found.length / 2 ? 1 : -1;

  const beats: number[] = [];
  const run: number[] = [];
  for (const f of found) {
    const index = polarity === 1 ? f.up : f.down;
    const last = beats.length - 1;
    if (last >= 0 && run[last] === f.run && index - beats[last] < ANALYSIS.refractoryS * fs) {
      if (polarity * (clean[index] - clean[beats[last]]) > 0) beats[last] = index;
      continue;
    }
    beats.push(index);
    run.push(f.run);
  }
  return { beats, run, polarity, analysedS: analysed / fs };
}

// ---------------------------------------------------------------------------------------
// Intervals, rhythm and variation

export function classifyIntervals(detection: BeatDetection, fs = SAMPLE_RATE_HZ): Interval[] {
  const raw: { t: number; rr: number; run: number }[] = [];
  const { beats, run } = detection;
  for (let i = 1; i < beats.length; i++) {
    if (run[i] === run[i - 1]) raw.push({ t: beats[i] / fs, rr: (beats[i] - beats[i - 1]) / fs, run: run[i] });
  }
  return raw.map((iv, i) => {
    const neighbours: number[] = [];
    for (let k = i - 5; k <= i + 5; k++) {
      if (k !== i && k >= 0 && k < raw.length && raw[k].run === iv.run) neighbours.push(raw[k].rr);
    }
    const reference = neighbours.length >= 3 ? median(neighbours) : iv.rr;
    const kind =
      iv.rr < (1 - ANALYSIS.ectopicTolerance) * reference
        ? 'premature'
        : iv.rr > (1 + ANALYSIS.ectopicTolerance) * reference
          ? 'delayed'
          : 'normal';
    return { t: iv.t, rr: iv.rr, kind };
  });
}

export function beatVariation(intervals: Interval[]): Variation | null {
  const nn = intervals.filter((iv) => iv.kind === 'normal');
  if (nn.length < 10) return null;
  const rr = nn.map((iv) => iv.rr * 1000);
  // Successive differences only between back-to-back normal intervals.
  const diffs: number[] = [];
  for (let i = 1; i < intervals.length; i++) {
    const a = intervals[i - 1];
    const b = intervals[i];
    const adjacent = Math.abs(b.t - b.rr - a.t) < 1e-6;
    if (a.kind === 'normal' && b.kind === 'normal' && adjacent) diffs.push((b.rr - a.rr) * 1000);
  }
  const sdnn = std(rr);
  const rmssd = diffs.length ? Math.sqrt(mean(diffs.map((d) => d * d))) : NaN;
  const sd1 = rmssd / Math.SQRT2;
  const hr = rr.map((v) => 60000 / v);
  return {
    beats: nn.length + 1,
    meanRR: mean(rr),
    meanHR: 60000 / mean(rr),
    minHR: Math.min(...hr),
    maxHR: Math.max(...hr),
    sdnn,
    rmssd,
    pnn50: diffs.length ? (100 * diffs.filter((d) => Math.abs(d) > 50).length) / diffs.length : NaN,
    sd1,
    sd2: Math.sqrt(Math.max(0, 2 * sdnn * sdnn - sd1 * sd1)),
  };
}

/** Shannon entropy of the RR histogram, normalised to 0–1 (Dash et al. 2009). */
function rrEntropy(rr: number[]): number {
  const lo = Math.min(...rr);
  const hi = Math.max(...rr);
  if (!(hi > lo)) return 0;
  const bins = new Array<number>(16).fill(0);
  for (const v of rr) bins[Math.min(15, Math.floor(((v - lo) / (hi - lo)) * 16))]++;
  let h = 0;
  for (const c of bins) if (c) h -= (c / rr.length) * Math.log(c / rr.length);
  return h / Math.log(16);
}

function turningPointRatio(rr: number[]): number {
  let turns = 0;
  for (let i = 1; i < rr.length - 1; i++) {
    if ((rr[i] - rr[i - 1]) * (rr[i + 1] - rr[i]) < 0) turns++;
  }
  return turns / Math.max(1, rr.length - 2);
}

export function describeRhythm(intervals: Interval[], detection: BeatDetection, pWaves: boolean | null): Rhythm {
  const premature = intervals.filter((iv) => iv.kind === 'premature').length;
  const pauses = intervals.filter((iv) => iv.rr >= ANALYSIS.pauseS).length;
  if (detection.analysedS < ANALYSIS.minAnalysedS || intervals.length < ANALYSIS.minBeats) {
    return {
      pattern: 'insufficient',
      rate: null,
      summary: `Needs ${ANALYSIS.minAnalysedS} s of steady signal`,
      findings: [],
      premature,
      pauses,
    };
  }

  // Irregularity of all intervals, trimming the extremes (Dash et al.).
  const sorted = intervals.map((iv) => iv.rr).sort((a, b) => a - b);
  const trim = Math.floor(sorted.length * 0.06);
  const kept = intervals.map((iv) => iv.rr).filter((v) => v >= sorted[trim] && v <= sorted[sorted.length - 1 - trim]);
  const diffs = kept.slice(1).map((v, i) => v - kept[i]);
  const nRmssd = Math.sqrt(mean(diffs.map((d) => d * d))) / mean(kept);
  const entropy = rrEntropy(kept);
  const tpr = turningPointRatio(kept);
  const chaotic = nRmssd > 0.1 && entropy > 0.7 && tpr > 0.54 && tpr < 0.77;

  const nn = intervals.filter((iv) => iv.kind === 'normal').map((iv) => iv.rr);
  const hr = 60 / median(nn.length ? nn : sorted);
  const rate = hr < REFERENCE.heartRate[0] ? 'slow' : hr > REFERENCE.heartRate[1] ? 'fast' : 'normal';
  const rateText = { slow: 'slow rate (<60)', normal: 'normal rate', fast: 'fast rate (>100)' }[rate];

  const findings: string[] = [];
  if (premature) {
    findings.push(`${premature} early beat${premature === 1 ? '' : 's'} (premature, or noise mistaken for a beat)`);
  }
  if (pauses) findings.push(`${pauses} pause${pauses === 1 ? '' : 's'} of ${ANALYSIS.pauseS} s or longer`);
  if (pWaves === true) findings.push('P wave before the QRS on the median beat');
  if (pWaves === false) findings.push('No clear P wave on the median beat');

  if (chaotic) {
    return {
      pattern: 'irregularly-irregular',
      rate,
      summary: `Irregularly irregular rhythm, ${rateText}`,
      findings: [
        'Beat timing is chaotic, a pattern that can occur with atrial fibrillation. This tool cannot diagnose it; see a clinician if this is unexpected.',
        ...findings,
      ],
      premature,
      pauses,
    };
  }
  const irregular = premature + pauses > 0.1 * intervals.length;
  return {
    pattern: irregular ? 'irregular' : 'regular',
    rate,
    summary: `${irregular ? 'Irregular' : 'Regular'} rhythm, ${rateText}`,
    findings,
    premature,
    pauses,
  };
}

// ---------------------------------------------------------------------------------------
// Median beat and intervals

/** Median of recent normal beats, band-passed for display and measurement, in mV. */
export function buildMedianBeat(
  counts: Float64Array,
  detection: BeatDetection,
  intervals: Interval[],
  fs = SAMPLE_RATE_HZ,
): { waveform: Float64Array; r: number; noiseMv: number; beats: number } | null {
  const normalRR = intervals.filter((iv) => iv.kind === 'normal').map((iv) => iv.rr);
  if (normalRR.length < 8) return null;
  const rr = median(normalRR);
  const pre = Math.round(ANALYSIS.templatePreS * fs);
  const post = Math.round(Math.min(0.7, Math.max(0.45, 0.75 * rr)) * fs);

  // Beats with a normal interval on both sides, newest first.
  const normalAt = new Set(intervals.filter((iv) => iv.kind === 'normal').map((iv) => Math.round(iv.t * fs)));
  const chosen: number[] = [];
  const { beats, run } = detection;
  for (let i = beats.length - 2; i >= 1 && chosen.length < ANALYSIS.templateBeats; i--) {
    if (run[i - 1] === run[i] && run[i] === run[i + 1] && normalAt.has(beats[i]) && normalAt.has(beats[i + 1])) {
      chosen.push(beats[i]);
    }
  }
  if (chosen.length < 8) return null;

  const clean = usable(counts, fs);
  const display = new Float64Array(clean.length).fill(NaN);
  for (const [a, b] of finiteRuns(clean, Math.round(ANALYSIS.minRunS * fs))) {
    const x = clean.subarray(a, b);
    const m = median(x);
    display.set(filtfilt(bandpass(0.5, 40, fs), x.map((v) => v - m)), a);
  }

  const length = pre + post + 1;
  const columns: number[][] = Array.from({ length }, () => []);
  let used = 0;
  for (const r of chosen) {
    if (r - pre < 0 || r + post >= display.length) continue;
    let ok = true;
    for (let k = -pre; k <= post && ok; k++) ok = Number.isFinite(display[r + k]);
    if (!ok) continue;
    for (let k = 0; k < length; k++) columns[k].push(display[r - pre + k]);
    used++;
  }
  if (used < 8) return null;
  const waveform = Float64Array.from(columns, (c) => countsToMv(median(c)));
  // Spread across beats, shrunk by averaging: how much a wave must stand out to count.
  const spread = columns.map((c) => {
    const m = median(c);
    return median(c.map((v) => Math.abs(v - m))) * 1.4826;
  });
  const noiseMv = Math.abs(countsToMv(median(spread))) / Math.sqrt(used);
  return { waveform, r: pre, noiseMv, beats: used };
}

/** Wave boundaries on the median beat (slope thresholds for QRS, tangent method for T end). */
export function delineate(waveform: Float64Array, r: number, rrS: number, noiseMv: number, fs = SAMPLE_RATE_HZ): Fiducials {
  const n = waveform.length;
  const ms = (s: number) => Math.round((s / 1000) * fs);
  const slope = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) slope[i] = (waveform[i + 1] - waveform[i - 1]) / 2;
  // QRS search runs from 70 ms before R (clear of the P wave) to 110 ms after it.
  const qrsFrom = Math.max(1, r - ms(70));
  const qrsTo = Math.min(n - 2, r + ms(110));
  let steepest = 0;
  for (let i = qrsFrom; i <= qrsTo; i++) steepest = Math.max(steepest, Math.abs(slope[i]));
  // Q and S slopes are gentle next to the R upstroke, so the thresholds are low.
  const steep = ANALYSIS.qrsSteep * steepest;
  const flat = ANALYSIS.qrsFlat * steepest;

  // QRS: from the outermost clearly sloped sample near R, settle outwards to flat signal.
  let first = r;
  let last = r;
  for (let i = qrsFrom; i <= qrsTo; i++) {
    if (Math.abs(slope[i]) > steep) {
      first = Math.min(first, i);
      last = Math.max(last, i);
    }
  }
  // Onset and J point: the first flat sample within 60 ms, else the flattest one there.
  const settle = (from: number, step: 1 | -1): number => {
    let flattest = from;
    for (let k = 0, i = from; k <= ms(ANALYSIS.qrsSettleMs) && i > 0 && i < n - 1; k++, i += step) {
      if (Math.abs(slope[i]) <= flat) return i;
      if (Math.abs(slope[i]) < Math.abs(slope[flattest])) flattest = i;
    }
    return flattest;
  };
  const qrsOnset = settle(first, -1);
  const qrsOffset = settle(last, 1);
  const baseline = waveform[qrsOnset];

  // T wave: largest deflection between the J point and most of the way to the next beat.
  // Stop short of where the next beat's P wave would start.
  const tFrom = qrsOffset + ms(60);
  const tTo = Math.min(n - 2, r + Math.round(Math.min(0.7 * rrS, rrS - 0.15) * fs));
  let tPeak: number | null = null;
  let tEnd: number | null = null;
  if (tTo > tFrom) {
    let best = tFrom;
    for (let i = tFrom; i <= tTo; i++) if (Math.abs(waveform[i] - baseline) > Math.abs(waveform[best] - baseline)) best = i;
    const amplitude = Math.abs(waveform[best] - baseline);
    if (amplitude >= Math.max(0.05, 4 * noiseMv)) {
      tPeak = best;
      // Tangent at the steepest point of the descending limb, extended to the baseline.
      let steepestAfter = best;
      for (let i = best; i <= tTo; i++) if (Math.abs(slope[i]) > Math.abs(slope[steepestAfter])) steepestAfter = i;
      const s = slope[steepestAfter];
      if (s !== 0) {
        const crossing = steepestAfter + (baseline - waveform[steepestAfter]) / s;
        if (crossing > best && crossing <= Math.min(n - 1, tTo + ms(20))) tEnd = Math.round(crossing);
      }
    }
  }

  // P wave: the most prominent bump (either sign) in the 300 ms before the QRS. Prominence,
  // not distance from the QRS baseline, so slow baseline sway can't pass for a P wave.
  let pPeak: number | null = null;
  let pOnset: number | null = null;
  // Start after the previous beat's T wave (assumed to end where this one does); at fast
  // rates T and P merge and the P wave is reported as not measurable rather than guessed.
  const previousTEnd = tEnd !== null ? tEnd - Math.round(rrS * fs) + ms(20) : r - Math.round(0.45 * rrS * fs);
  const pFrom = Math.max(1, qrsOnset - ms(300), previousTEnd);
  const pTo = qrsOnset - ms(20);
  if (pTo - pFrom > ms(60)) {
    const edge = ms(30);
    let best: { index: number; sign: 1 | -1; prominence: number } | null = null;
    for (const sign of [1, -1] as const) {
      const y = Array.from(waveform.subarray(pFrom, pTo + 1), (v) => sign * v);
      const { indices, prominences } = findPeaks(y);
      indices.forEach((i, k) => {
        if (i < edge || i > y.length - 1 - ms(5)) return;
        if (!best || prominences[k] > best.prominence) best = { index: pFrom + i, sign, prominence: prominences[k] };
      });
    }
    const p = best as { index: number; sign: 1 | -1; prominence: number } | null;
    if (p && p.prominence >= Math.max(0.03, 4 * noiseMv)) {
      // Onset: walking left, where the bump has fallen to 10% of its height.
      let low = p.index;
      for (let i = p.index; i >= pFrom; i--) if (p.sign * waveform[i] < p.sign * waveform[low]) low = i;
      const level = p.sign * waveform[low] + 0.1 * (p.sign * waveform[p.index] - p.sign * waveform[low]);
      let onset = p.index;
      while (onset > low && p.sign * waveform[onset] > level) onset--;
      pPeak = p.index;
      if (onset > pFrom) pOnset = onset;
    }
  }
  return { pOnset, pPeak, qrsOnset, r, qrsOffset, tPeak, tEnd };
}

function measure(f: Fiducials, rrS: number, fs: number): Intervals {
  const toMs = (samples: number) => (samples / fs) * 1000;
  const within = (v: number, lo: number, hi: number) => (v >= lo && v <= hi ? Math.round(v) : null);
  const pr = f.pOnset !== null ? within(toMs(f.qrsOnset - f.pOnset), 60, 400) : null;
  const qrs = within(toMs(f.qrsOffset - f.qrsOnset), 40, 200);
  const qt = f.tEnd !== null ? within(toMs(f.tEnd - f.qrsOnset), 200, 700) : null;
  return {
    pr,
    qrs,
    qt,
    qtcBazett: qt !== null ? Math.round(qt / Math.sqrt(rrS)) : null,
    qtcFridericia: qt !== null ? Math.round(qt / Math.cbrt(rrS)) : null,
  };
}

// ---------------------------------------------------------------------------------------

/** Full analysis of raw ECG counts (NaN for gaps) covering the last ANALYSIS.windowS. */
export function analyseEcg(counts: Float64Array, fs = SAMPLE_RATE_HZ): EcgAnalysis {
  const window = counts.subarray(Math.max(0, counts.length - Math.round(ANALYSIS.windowS * fs)));
  const detection = detectBeats(window, fs);
  const intervals = classifyIntervals(detection, fs);
  const template = buildMedianBeat(window, detection, intervals, fs);
  let medianBeat: MedianBeat | null = null;
  if (template) {
    const rr = median(intervals.filter((iv) => iv.kind === 'normal').map((iv) => iv.rr));
    const fiducials = delineate(template.waveform, template.r, rr, template.noiseMv, fs);
    medianBeat = { waveform: template.waveform, fiducials, intervals: measure(fiducials, rr, fs), beatsAveraged: template.beats };
  }
  const pWaves = medianBeat ? medianBeat.fiducials.pOnset !== null : null;
  return {
    windowS: window.length / fs,
    detection,
    intervals,
    rhythm: describeRhythm(intervals, detection, pWaves),
    variation: beatVariation(intervals),
    medianBeat,
  };
}
