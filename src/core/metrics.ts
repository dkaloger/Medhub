/**
 * Experimental, non-diagnostic rate estimates and signal checks.
 *
 * Every function takes raw ADC counts (NaN for gaps) ending at the moment of interest and
 * only analyses the newest gap-free stretch, so samples on either side of a dropout are
 * never spliced together.
 */
import { ADC_MAX, CLIP_MARGIN, SAMPLE_RATE_HZ, countsToMv, isClipped } from './device';
import { bandpass, filtfilt, highpass } from './filters';
import { findPeaks } from './peaks';
import { mean, median, movingAverage, peakToPeak, percentile, std, trailingFinite } from './stats';

export interface RateEstimate {
  value: number | null;
  /** Why there is no value, or empty when there is one. */
  reason: string;
}

export type SignalStatus = 'no-data' | 'collecting' | 'clipped' | 'flat' | 'ok';

/**
 * - off: the respiration input is pinned at positive full scale, which is what the
 *   ADS1292R's impedance demodulator does when its electrodes aren't touching skin
 * - movement: ECG excursions far larger than any heartbeat (handling leads, moving)
 * - stable: none of the above; whether beats are visible is up to heartRate()
 */
export type ContactStatus = 'no-data' | 'collecting' | 'off' | 'movement' | 'ecg-clipped' | 'stable';

const STATUS_WINDOW_S = 5;
const MIN_STATUS_S = 2;
const MAX_CLIPPED_FRACTION = 0.01;
const MIN_PEAK_TO_PEAK_COUNTS = 40;
const MIN_COVERAGE = 0.5;

export const HEART = {
  windowS: 15,
  minS: 8,
  band: [5, 25] as const,
  integrateS: 0.1,
  refractoryS: 0.3,
  minBpm: 30,
  maxBpm: 200,
  maxVariation: 0.25,
  /** A beat must reach this fraction of a typical tall bump in slope energy. */
  beatFraction: 0.3,
  /** Median beat energy over median background energy. */
  minContrast: 8,
};

export const BREATHING = {
  windowS: 60,
  minS: 25,
  band: [0.07, 0.7] as const,
  minIntervalS: 1.5,
  maxIntervalS: 10,
  maxVariation: 0.35,
  minAmplitudeCounts: 5,
};

export const CONTACT = {
  windowS: 3,
  /** Fraction of respiration samples at the positive rail that means "electrodes off". */
  maxRespRailFraction: 0.5,
  /**
   * High-passed ECG beyond this is movement, not cardiac activity (QRS is a few mV).
   * Tuned on a real bench session: handling the leads produced 50–350 mV swings.
   */
  artifactMv: 30,
  /** Samples this close to an excursion are discarded too. */
  artifactPadS: 0.25,
  maxArtifactFraction: 0.1,
};

function tail(values: Float64Array, seconds: number, fs: number): Float64Array {
  return values.subarray(Math.max(0, values.length - Math.round(seconds * fs)));
}

function clippedFraction(values: Float64Array): number {
  let clipped = 0;
  for (let i = 0; i < values.length; i++) if (isClipped(values[i])) clipped++;
  return values.length ? clipped / values.length : 0;
}

function centred(values: Float64Array): Float64Array {
  const m = median(values);
  return values.map((v) => v - m);
}

function railFraction(values: Float64Array): number {
  let pinned = 0;
  for (let i = 0; i < values.length; i++) if (values[i] >= ADC_MAX - CLIP_MARGIN) pinned++;
  return values.length ? pinned / values.length : 0;
}

/**
 * Copy of a gap-free ECG stretch with NaN wherever it moves more than a heartbeat could,
 * padded either side, so analyses can use the clean data around a movement artefact.
 */
export function maskArtifacts(counts: Float64Array, fs = SAMPLE_RATE_HZ): Float64Array {
  const out = Float64Array.from(counts);
  if (counts.length < 2) return out;
  const hp = filtfilt([highpass(0.5, fs)], centred(counts));
  const limit = CONTACT.artifactMv / countsToMv(1);
  const pad = Math.round(CONTACT.artifactPadS * fs);
  let maskedUntil = -1;
  for (let i = 0; i < hp.length; i++) {
    if (Math.abs(hp[i]) <= limit) continue;
    for (let k = Math.max(maskedUntil + 1, i - pad); k <= Math.min(hp.length - 1, i + pad); k++) out[k] = NaN;
    maskedUntil = Math.min(hp.length - 1, i + pad);
  }
  return out;
}

/** Whether the electrodes look attached and still, from the last few seconds of both channels. */
export function electrodeContact(ecg: Float64Array, resp: Float64Array, fs = SAMPLE_RATE_HZ): ContactStatus {
  const recent = tail(ecg, CONTACT.windowS, fs);
  if (!recent.some(Number.isFinite)) return 'no-data';
  const segment = trailingFinite(recent);
  if (segment.length < MIN_STATUS_S * fs) return 'collecting';
  const respRecent = trailingFinite(tail(resp, CONTACT.windowS, fs));
  if (respRecent.length >= MIN_STATUS_S * fs && railFraction(respRecent) > CONTACT.maxRespRailFraction) return 'off';
  if (clippedFraction(segment) > MAX_CLIPPED_FRACTION) return 'ecg-clipped';
  const masked = maskArtifacts(segment, fs);
  const artefact = masked.reduce((n, v) => n + (Number.isNaN(v) ? 1 : 0), 0) / masked.length;
  return artefact > CONTACT.maxArtifactFraction ? 'movement' : 'stable';
}

/** Flags obvious ADC failures. It cannot tell whether electrodes are in contact. */
export function signalStatus(counts: Float64Array, fs = SAMPLE_RATE_HZ): SignalStatus {
  const recent = tail(counts, STATUS_WINDOW_S, fs);
  if (!recent.some(Number.isFinite)) return 'no-data';
  const segment = trailingFinite(recent);
  if (segment.length < MIN_STATUS_S * fs) return 'collecting';
  if (clippedFraction(segment) > MAX_CLIPPED_FRACTION) return 'clipped';
  if (peakToPeak(segment) < MIN_PEAK_TO_PEAK_COUNTS) return 'flat';
  return 'ok';
}

/**
 * The newest stretch with no gaps and no clipped samples. A saturated stretch carries no
 * signal, so like a dropout it ends the analysis window rather than being spliced in.
 */
function cleanTail(values: Float64Array, seconds: number, fs: number): { segment: Float64Array; clippedNow: boolean } {
  const recent = trailingFinite(tail(values, seconds, fs));
  const clippedNow = recent.length > 0 && isClipped(recent[recent.length - 1]);
  return { segment: trailingFinite(recent.map((v) => (isClipped(v) ? NaN : v))), clippedNow };
}

function screen(segment: Float64Array, minSamples: number, clippedNow: boolean): RateEstimate | null {
  if (clippedNow) return { value: null, reason: 'ADC clipped' };
  if (segment.length < minSamples) return { value: null, reason: 'collecting' };
  if (peakToPeak(segment) < MIN_PEAK_TO_PEAK_COUNTS) return { value: null, reason: 'flat signal' };
  return null;
}

function inRange(intervalsS: number[], minS: number, maxS: number): number[] {
  return intervalsS.filter((s) => s >= minS && s <= maxS);
}

/**
 * Median-interval rate, or null when there are too few cycles, they vary too much, or the
 * accepted intervals cover less than half the window (too many missed or rejected cycles).
 */
function rateFromIntervals(
  intervalsS: number[],
  minS: number,
  maxS: number,
  maxVariation: number,
  windowS: number,
  cycle: string,
): RateEstimate {
  const valid = inRange(intervalsS, minS, maxS);
  if (valid.length < 3) return { value: null, reason: `no clear ${cycle}s` };
  if (std(valid) / mean(valid) > maxVariation) return { value: null, reason: 'irregular or noisy' };
  if (valid.reduce((a, b) => a + b, 0) < MIN_COVERAGE * windowS) {
    return { value: null, reason: `too many missed ${cycle}s` };
  }
  return { value: Math.round(60 / median(valid)), reason: '' };
}

/** QRS detection on the band-passed slope energy (Pan–Tompkins style). */
export function heartRate(counts: Float64Array, fs = SAMPLE_RATE_HZ): RateEstimate {
  const { segment: unmasked, clippedNow } = cleanTail(counts, HEART.windowS, fs);
  // Analyse only the clean stretch after the latest movement artefact.
  const segment = trailingFinite(maskArtifacts(unmasked, fs));
  if (!clippedNow && segment.length < HEART.minS * fs && unmasked.length >= HEART.minS * fs) {
    return { value: null, reason: 'movement artefact' };
  }
  const rejected = screen(segment, HEART.minS * fs, clippedNow);
  if (rejected) return rejected;

  const band = filtfilt(bandpass(HEART.band[0], HEART.band[1], fs), centred(segment));
  const slopeEnergy = new Float64Array(band.length);
  for (let i = 1; i < band.length; i++) slopeEnergy[i] = (band[i] - band[i - 1]) ** 2;
  const energy = movingAverage(slopeEnergy, Math.round(HEART.integrateS * fs));

  // Beats are the taller half of the candidate bumps. Taking the threshold from them, not
  // from the maximum, keeps one movement artefact from hiding every beat around it.
  const candidates = findPeaks(energy, { distance: HEART.refractoryS * fs }).indices;
  const threshold = HEART.beatFraction * percentile(candidates.map((i) => energy[i]), 75);
  if (!(threshold > 0)) return { value: null, reason: 'flat signal' };
  const beats = candidates.filter((i) => energy[i] >= threshold);
  if (beats.length < 4) return { value: null, reason: 'no clear beats' };

  // QRS complexes are brief bursts over a quiet baseline; noise is busy everywhere.
  const contrast = median(beats.map((i) => energy[i])) / median(energy);
  if (!(contrast >= HEART.minContrast)) return { value: null, reason: 'no clear beats' };

  const intervals = beats.slice(1).map((p, i) => (p - beats[i]) / fs);
  return rateFromIntervals(intervals, 60 / HEART.maxBpm, 60 / HEART.minBpm, HEART.maxVariation, segment.length / fs, 'beat');
}

/** Breath detection on band-passed ADS1292R CH1 (impedance) counts. */
export function breathingRate(counts: Float64Array, fs = SAMPLE_RATE_HZ): RateEstimate {
  const recent = trailingFinite(tail(counts, CONTACT.windowS, fs));
  if (railFraction(recent) > CONTACT.maxRespRailFraction) return { value: null, reason: 'input saturated: electrodes off?' };
  const { segment, clippedNow } = cleanTail(counts, BREATHING.windowS, fs);
  const rejected = screen(segment, BREATHING.minS * fs, clippedNow);
  if (rejected) return rejected;

  const band = filtfilt(bandpass(BREATHING.band[0], BREATHING.band[1], fs), centred(segment));
  const amplitude = percentile(band, 95) - percentile(band, 5);
  if (amplitude < BREATHING.minAmplitudeCounts) return { value: null, reason: 'no breathing signal' };

  const { indices } = findPeaks(band, {
    distance: BREATHING.minIntervalS * fs,
    prominence: 0.3 * amplitude,
  });
  if (indices.length < 4) return { value: null, reason: 'no clear breaths' };
  const intervals = indices.slice(1).map((p, i) => (p - indices[i]) / fs);
  return rateFromIntervals(
    intervals,
    BREATHING.minIntervalS,
    BREATHING.maxIntervalS,
    BREATHING.maxVariation,
    segment.length / fs,
    'breath',
  );
}
