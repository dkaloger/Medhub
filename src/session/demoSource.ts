import { SAMPLE_RATE_HZ } from '../core/device';
import { noiseGenerator, syntheticEcg, syntheticResp } from '../core/synthetic';
import type { SampleSource, SourceEvent } from './sources';

const TICK_MS = 40;

/** Synthetic ECG and respiration paced in real time. Everything it produces is labelled simulated. */
export class DemoSource implements SampleSource {
  readonly label = 'Simulated signal';
  readonly simulated = true;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly bpm = 72,
    private readonly breathsPerMinute = 15,
  ) {}

  start(emit: (event: SourceEvent) => void): void {
    emit({ type: 'state', state: 'connected', detail: 'Simulated signal — no hardware' });
    const noise = noiseGenerator(Date.now());
    const startedAt = performance.now();
    let produced = 0;
    this.timer = setInterval(() => {
      const now = performance.now();
      const due = Math.floor(((now - startedAt) / 1000) * SAMPLE_RATE_HZ);
      if (due <= produced) return;
      const n = due - produced;
      const ecg = new Float64Array(n);
      const resp = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        const t = (produced + i) / SAMPLE_RATE_HZ;
        ecg[i] = Math.round(syntheticEcg(t, this.bpm) + 150 * noise());
        resp[i] = Math.round(syntheticResp(t, this.breathsPerMinute) + 40 * noise());
      }
      produced = due;
      emit({ type: 'batch', batch: { ecg, resp, receivedAt: now } });
    }, TICK_MS);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
