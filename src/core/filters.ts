/**
 * IIR filters built from second-order sections, matching SciPy's conventions so the
 * coefficients and outputs can be checked against scipy.signal (see tests/dsp.test.ts).
 */
import { SAMPLE_RATE_HZ } from './device';

/** [b0, b1, b2, a1, a2] with a0 normalised to 1 (transposed direct form II). */
export type Biquad = readonly [number, number, number, number, number];

const BUTTERWORTH_Q = Math.SQRT1_2;

/** Second-order Butterworth low-pass; equals scipy.signal.butter(2, fc, 'low'). */
export function lowpass(cutoffHz: number, fs = SAMPLE_RATE_HZ): Biquad {
  const k = Math.tan((Math.PI * cutoffHz) / fs);
  const norm = 1 / (1 + k / BUTTERWORTH_Q + k * k);
  const b0 = k * k * norm;
  return [b0, 2 * b0, b0, 2 * (k * k - 1) * norm, (1 - k / BUTTERWORTH_Q + k * k) * norm];
}

/** Second-order Butterworth high-pass; equals scipy.signal.butter(2, fc, 'high'). */
export function highpass(cutoffHz: number, fs = SAMPLE_RATE_HZ): Biquad {
  const k = Math.tan((Math.PI * cutoffHz) / fs);
  const norm = 1 / (1 + k / BUTTERWORTH_Q + k * k);
  return [norm, -2 * norm, norm, 2 * (k * k - 1) * norm, (1 - k / BUTTERWORTH_Q + k * k) * norm];
}

/** Notch filter; equals scipy.signal.iirnotch(f0, q, fs). */
export function notch(f0Hz: number, q = 30, fs = SAMPLE_RATE_HZ): Biquad {
  const w0 = (2 * Math.PI * f0Hz) / fs;
  const beta = Math.tan(w0 / q / 2);
  const gain = 1 / (1 + beta);
  const c = -2 * Math.cos(w0);
  return [gain, gain * c, gain, gain * c, 2 * gain - 1];
}

/** High-pass then low-pass, i.e. a fourth-order band-pass. */
export function bandpass(lowHz: number, highHz: number, fs = SAMPLE_RATE_HZ): Biquad[] {
  return [highpass(lowHz, fs), lowpass(highHz, fs)];
}

function dcGain([b0, b1, b2, a1, a2]: Biquad): number {
  return (b0 + b1 + b2) / (1 + a1 + a2);
}

/** Section states for a constant input `x0`, like scipy.signal.sosfilt_zi(sos) * x0. */
function steadyState(sections: readonly Biquad[], x0: number, state: Float64Array): void {
  let v = x0;
  sections.forEach((section, s) => {
    const [b0, , b2, , a2] = section;
    const y = dcGain(section) * v;
    state[2 * s] = y - b0 * v;
    state[2 * s + 1] = b2 * v - a2 * y;
    v = y;
  });
}

function step(sections: readonly Biquad[], state: Float64Array, x: number): number {
  let v = x;
  for (let s = 0; s < sections.length; s++) {
    const [b0, b1, b2, a1, a2] = sections[s];
    const y = b0 * v + state[2 * s];
    state[2 * s] = b1 * v - a1 * y + state[2 * s + 1];
    state[2 * s + 1] = b2 * v - a2 * y;
    v = y;
  }
  return v;
}

/**
 * Causal filter that keeps its state between chunks, so a live stream is filtered once,
 * sample by sample, exactly as if it had been filtered in one piece.
 *
 * NaN (a gap) passes through as NaN and resets the state. The next finite sample
 * restarts the filter at steady state, so a DC offset of ~10^6 counts does not ring.
 */
export class FilterChain {
  private readonly state: Float64Array;
  private primed = false;

  constructor(readonly sections: readonly Biquad[] = []) {
    this.state = new Float64Array(2 * sections.length);
  }

  reset(): void {
    this.primed = false;
  }

  process(input: ArrayLike<number>): Float64Array {
    const out = new Float64Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const x = input[i];
      if (!Number.isFinite(x)) {
        out[i] = NaN;
        this.primed = false;
        continue;
      }
      if (!this.primed) {
        steadyState(this.sections, x, this.state);
        this.primed = true;
      }
      out[i] = step(this.sections, this.state, x);
    }
    return out;
  }
}

/**
 * Zero-phase forward-backward filtering of a finite signal; equals
 * scipy.signal.sosfiltfilt(sos, x) with its default odd-extension padding.
 */
export function filtfilt(sections: readonly Biquad[], x: ArrayLike<number>): Float64Array {
  const n = x.length;
  if (n === 0 || sections.length === 0) return Float64Array.from(x);
  const pad = Math.min(n - 1, 3 * (2 * sections.length + 1));
  const ext = new Float64Array(n + 2 * pad);
  for (let i = 0; i < pad; i++) ext[i] = 2 * x[0] - x[pad - i];
  for (let i = 0; i < n; i++) ext[pad + i] = x[i];
  for (let i = 0; i < pad; i++) ext[pad + n + i] = 2 * x[n - 1] - x[n - 2 - i];

  const state = new Float64Array(2 * sections.length);
  steadyState(sections, ext[0], state);
  for (let i = 0; i < ext.length; i++) ext[i] = step(sections, state, ext[i]);
  ext.reverse();
  steadyState(sections, ext[0], state);
  for (let i = 0; i < ext.length; i++) ext[i] = step(sections, state, ext[i]);
  ext.reverse();
  return ext.slice(pad, pad + n);
}

/** Display filter presets offered in the UI. */
export const ECG_FILTERS = {
  raw: { label: 'Raw', sections: (): Biquad[] => [] },
  lowpass40: { label: 'Low-pass 40 Hz', sections: (): Biquad[] => [lowpass(40)] },
  monitor: { label: 'Monitor 0.5–40 Hz', sections: (): Biquad[] => bandpass(0.5, 40) },
} as const;
export type EcgFilterId = keyof typeof ECG_FILTERS;

export const MAINS_NOTCH = {
  off: { label: 'No notch', sections: (): Biquad[] => [] },
  hz50: { label: '50 Hz notch', sections: (): Biquad[] => [notch(50)] },
  hz60: { label: '60 Hz notch', sections: (): Biquad[] => [notch(60)] },
} as const;
export type NotchId = keyof typeof MAINS_NOTCH;

export const RESP_FILTERS = {
  raw: { label: 'Raw', sections: (): Biquad[] => [] },
  lowpass2: { label: 'Low-pass 2 Hz', sections: (): Biquad[] => [lowpass(2)] },
  breathing: { label: 'Breathing 0.07–0.7 Hz', sections: (): Biquad[] => bandpass(0.07, 0.7) },
} as const;
export type RespFilterId = keyof typeof RESP_FILTERS;

export function ecgDisplayChain(filter: EcgFilterId, mains: NotchId): FilterChain {
  return new FilterChain([...MAINS_NOTCH[mains].sections(), ...ECG_FILTERS[filter].sections()]);
}

export function respDisplayChain(filter: RespFilterId): FilterChain {
  return new FilterChain(RESP_FILTERS[filter].sections());
}
