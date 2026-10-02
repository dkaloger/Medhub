/** Synthetic signals for demo mode and tests. Never presented as real data. */

const ECG_WAVES = [
  // [offset from R peak (s), width (s), amplitude (counts)]
  [-0.2, 0.035, 1500], // P
  [-0.018, 0.01, -2500], // Q
  [0, 0.012, 12500], // R
  [0.022, 0.012, -4000], // S
  [0.2, 0.06, 3500], // T
] as const;

/** ECG counts at time `t` seconds; beats are centred on multiples of the RR interval. */
export function syntheticEcg(t: number, bpm = 72, baseline = -700_000): number {
  const rr = 60 / bpm;
  const phase = t - Math.round(t / rr) * rr;
  let value = baseline + 200 * Math.sin(2 * Math.PI * 0.2 * t);
  for (const [offset, width, amplitude] of ECG_WAVES) {
    value += amplitude * Math.exp(-0.5 * ((phase - offset) / width) ** 2);
  }
  return value;
}

/** Respiration (CH1) counts at time `t` seconds. */
export function syntheticResp(t: number, breathsPerMinute = 15, baseline = 1_000_000): number {
  const f = breathsPerMinute / 60;
  return baseline + 1500 * Math.sin(2 * Math.PI * f * t) + 300 * Math.sin(2 * Math.PI * 0.013 * t);
}

/** Deterministic pseudo-random noise in [-1, 1) (mulberry32). */
export function noiseGenerator(seed = 1): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 31 - 1;
  };
}
