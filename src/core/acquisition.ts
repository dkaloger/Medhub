/**
 * Live acquisition state: every sample from the device passes through here exactly once.
 *
 * The firmware has no sample counter, so dropouts are inferred from host arrival times:
 * if far fewer samples arrive than the elapsed time implies, the shortfall is inserted as a
 * NaN gap. That keeps the timeline honest across unplugs, Bluetooth dropouts and device
 * resets instead of silently splicing the two sides together.
 */
import { SAMPLE_RATE_HZ } from './device';
import { FilterChain } from './filters';
import { RingBuffer } from './series';

export interface SampleBatch {
  ecg: Float64Array;
  /** NaN where the firmware sent no respiration value. */
  resp: Float64Array;
  /** Monotonic arrival time in milliseconds. */
  receivedAt: number;
}

export interface AcquisitionListener {
  samples?(firstIndex: number, ecg: Float64Array, resp: Float64Array): void;
  event?(index: number, text: string): void;
}

/** Raw samples plus a causally filtered copy for display, both indexed identically. */
export class Channel {
  readonly raw: RingBuffer;
  readonly display: RingBuffer;
  private chain = new FilterChain();
  /** Index of the newest finite sample, or -1 if none has ever arrived. */
  lastFiniteIndex = -1;

  constructor(capacity: number) {
    this.raw = new RingBuffer(capacity);
    this.display = new RingBuffer(capacity);
  }

  push(values: Float64Array): void {
    const first = this.raw.end;
    for (let i = values.length - 1; i >= 0; i--) {
      if (Number.isFinite(values[i])) {
        this.lastFiniteIndex = first + i;
        break;
      }
    }
    this.raw.push(values);
    this.display.push(this.chain.process(values));
  }

  pushGap(count: number): void {
    this.raw.pushGap(count);
    this.display.pushGap(count);
    this.chain.reset();
  }

  /** Swap the display filter and re-filter everything still buffered. */
  setFilter(chain: FilterChain): void {
    this.chain = chain;
    const { start, values } = this.raw.read(this.raw.start, this.raw.end);
    this.display.reset(start);
    this.display.push(chain.process(values));
  }
}

export class Acquisition {
  static readonly GAP_THRESHOLD_S = 0.5;
  private static readonly RATE_WINDOW_MS = 5000;

  readonly ecg: Channel;
  readonly resp: Channel;
  samplesReceived = 0;
  readonly gaps: { index: number; count: number }[] = [];
  private lastArrival: number | null = null;
  private arrivals: { at: number; count: number }[] = [];
  private readonly listeners = new Set<AcquisitionListener>();

  constructor(
    capacitySamples: number,
    readonly fs = SAMPLE_RATE_HZ,
  ) {
    this.ecg = new Channel(capacitySamples);
    this.resp = new Channel(capacitySamples);
  }

  /** Index the next sample will get; also the total timeline length including gaps. */
  get end(): number {
    return this.ecg.raw.end;
  }

  subscribe(listener: AcquisitionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  ingest(batch: SampleBatch): void {
    const count = batch.ecg.length;
    if (count === 0) return;
    if (this.lastArrival !== null) {
      const elapsed = Math.round(((batch.receivedAt - this.lastArrival) / 1000) * this.fs);
      const missing = elapsed - count;
      if (missing > Acquisition.GAP_THRESHOLD_S * this.fs) this.insertGap(missing);
    }
    this.lastArrival = batch.receivedAt;
    this.arrivals.push({ at: batch.receivedAt, count });
    this.trimArrivals(batch.receivedAt);

    const first = this.end;
    this.ecg.push(batch.ecg);
    this.resp.push(batch.resp);
    this.samplesReceived += count;
    for (const l of this.listeners) l.samples?.(first, batch.ecg, batch.resp);
  }

  /** Record something that happened at the current point in the timeline. */
  note(text: string): void {
    for (const l of this.listeners) l.event?.(this.end, text);
  }

  /**
   * Samples per second over the last few seconds of arrivals, or null if too little data.
   * Uses only the source's own timestamps, whose clock may differ from the caller's.
   */
  measuredRate(): number | null {
    if (this.arrivals.length < 2) return null;
    const span = this.arrivals[this.arrivals.length - 1].at - this.arrivals[0].at;
    if (span < 1000) return null;
    const counted = this.arrivals.slice(1).reduce((sum, a) => sum + a.count, 0);
    return (counted / span) * 1000;
  }

  private trimArrivals(now: number): void {
    while (this.arrivals.length && now - this.arrivals[0].at > Acquisition.RATE_WINDOW_MS) this.arrivals.shift();
  }

  private insertGap(count: number): void {
    const index = this.end;
    this.ecg.pushGap(count);
    this.resp.pushGap(count);
    this.gaps.push({ index, count });
    this.arrivals = [];
    const seconds = (count / this.fs).toFixed(1);
    for (const l of this.listeners) {
      l.event?.(index, `Gap of about ${seconds} s (${count} samples), estimated from arrival times`);
    }
  }
}
