/**
 * Owns everything about the live stream outside React: the source, the acquisition
 * buffers, continuous logging, clip recording and once-a-second metrics. React reads it
 * through subscribe()/getSnapshot() (useSyncExternalStore); plots read buffers directly.
 */
import { Acquisition } from '../core/acquisition';
import { ANALYSIS, analyseEcg, type EcgAnalysis } from '../core/ecgAnalysis';
import { SAMPLE_RATE_HZ } from '../core/device';
import {
  ecgDisplayChain,
  respDisplayChain,
  type EcgFilterId,
  type NotchId,
  type RespFilterId,
} from '../core/filters';
import {
  breathingRate,
  electrodeContact,
  heartRate,
  signalStatus,
  type ContactStatus,
  type RateEstimate,
  type SignalStatus,
} from '../core/metrics';
import { ClipRecorder, SessionLogger, type RecordingStore } from '../core/recorder';
import type { SampleSource, SourceEvent } from './sources';

export const BUFFER_SECONDS = 600;
export const CLIP_SECONDS = 120;
const TICK_MS = 1000;
/** Beat analysis is heavier than the other metrics, so it runs every few ticks. */
const ANALYSIS_EVERY_TICKS = 3;
const RESP_PRESENT_WINDOW_S = 5;

export interface SessionSnapshot {
  connection: 'idle' | 'connecting' | 'connected' | 'disconnected';
  detail: string;
  sourceLabel: string | null;
  simulated: boolean;
  samplesReceived: number;
  measuredRate: number | null;
  gaps: number;
  heart: RateEstimate;
  breathing: RateEstimate;
  contact: ContactStatus;
  /** Rhythm, intervals and beat variation; refreshed every few seconds. */
  analysis: EcgAnalysis | null;
  respStatus: SignalStatus;
  respPresent: boolean;
  lastMessage: { text: string; isError: boolean; at: number } | null;
  logging: { location: string; seconds: number } | null;
  loggingError: string | null;
  storageLocation: string | null;
  clip: { seconds: number; maxSeconds: number } | null;
  lastClip: { path: string; error: string | null } | null;
}

const NO_RATE: RateEstimate = { value: null, reason: 'no data' };

const INITIAL: SessionSnapshot = {
  connection: 'idle',
  detail: 'Not connected',
  sourceLabel: null,
  simulated: false,
  samplesReceived: 0,
  measuredRate: null,
  gaps: 0,
  heart: NO_RATE,
  breathing: NO_RATE,
  contact: 'no-data',
  analysis: null,
  respStatus: 'no-data',
  respPresent: false,
  lastMessage: null,
  logging: null,
  loggingError: null,
  storageLocation: null,
  clip: null,
  lastClip: null,
};

export class LiveSession {
  acquisition: Acquisition | null = null;
  private source: SampleSource | null = null;
  private logger: SessionLogger | null = null;
  private clip: ClipRecorder | null = null;
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private snapshot: SessionSnapshot = INITIAL;
  private readonly listeners = new Set<() => void>();
  private lastTickSamples = 0;
  private ticks = 0;
  private ecgFilter: { filter: EcgFilterId; notch: NotchId } = { filter: 'monitor', notch: 'off' };
  private respFilter: RespFilterId = 'lowpass2';

  constructor(private store: RecordingStore | null) {
    this.snapshot = { ...INITIAL, storageLocation: store?.location ?? null };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): SessionSnapshot => this.snapshot;

  get active(): boolean {
    return this.source !== null;
  }

  async connect(source: SampleSource): Promise<void> {
    await this.disconnect();
    const acquisition = new Acquisition(BUFFER_SECONDS * SAMPLE_RATE_HZ);
    acquisition.ecg.setFilter(ecgDisplayChain(this.ecgFilter.filter, this.ecgFilter.notch));
    acquisition.resp.setFilter(respDisplayChain(this.respFilter));
    const logger = this.store ? new SessionLogger(this.store, source.simulated) : null;
    this.acquisition = acquisition;
    this.logger = logger;
    this.lastTickSamples = 0;
    this.source = source;
    this.unsubscribe = acquisition.subscribe({
      samples: (first, ecg, resp) => {
        logger?.write(first, ecg, resp);
        if (this.clip?.write(first, ecg, resp)) void this.stopClip();
      },
      event: (index, text) => logger?.event(index, text),
    });
    logger?.event(0, `Session started: ${source.label}${source.simulated ? ' (SIMULATED)' : ''}`);
    this.update({
      ...INITIAL,
      storageLocation: this.store?.location ?? null,
      connection: 'connecting',
      detail: `Starting ${source.label}…`,
      sourceLabel: source.label,
      simulated: source.simulated,
      logging: logger ? { location: logger.location, seconds: 0 } : null,
    });
    source.start((event) => this.handle(source, event));
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  async disconnect(): Promise<void> {
    const source = this.source;
    if (!source) return;
    this.source = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await source.stop();
    await this.stopClip();
    this.acquisition?.note('Session stopped');
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.logger?.close();
    this.update({ connection: 'idle', detail: 'Not connected', clip: null });
  }

  setStore(store: RecordingStore | null): void {
    this.store = store;
    this.update({ storageLocation: store?.location ?? null });
  }

  setEcgFilter(filter: EcgFilterId, notch: NotchId): void {
    this.ecgFilter = { filter, notch };
    this.acquisition?.ecg.setFilter(ecgDisplayChain(filter, notch));
  }

  setRespFilter(filter: RespFilterId): void {
    this.respFilter = filter;
    this.acquisition?.resp.setFilter(respDisplayChain(filter));
  }

  startClip(): void {
    if (!this.store || !this.source || this.clip) return;
    this.clip = new ClipRecorder(this.store, this.source.simulated, CLIP_SECONDS);
    this.update({ clip: { seconds: 0, maxSeconds: CLIP_SECONDS } });
  }

  async stopClip(): Promise<void> {
    const clip = this.clip;
    if (!clip) return;
    this.clip = null;
    await clip.close();
    this.update({
      clip: null,
      lastClip: clip.samples > 0 ? { path: clip.path, error: clip.error } : { path: '', error: 'No samples recorded' },
    });
  }

  private handle(source: SampleSource, event: SourceEvent): void {
    if (source !== this.source || !this.acquisition) return;
    switch (event.type) {
      case 'batch':
        this.acquisition.ingest(event.batch);
        break;
      case 'state':
        this.acquisition.note(event.detail);
        this.update({ connection: event.state, detail: event.detail });
        break;
      case 'message':
        this.acquisition.note(`Device: ${event.text}`);
        this.update({ lastMessage: { text: event.text, isError: event.isError, at: Date.now() } });
        break;
    }
  }

  private tick(): void {
    const acq = this.acquisition;
    if (!acq) return;
    const end = acq.end;
    const ecg = acq.ecg.raw.read(end - 15 * SAMPLE_RATE_HZ, end).values;
    const resp = acq.resp.raw.read(end - 60 * SAMPLE_RATE_HZ, end).values;
    const respPresent = acq.resp.lastFiniteIndex >= end - RESP_PRESENT_WINDOW_S * SAMPLE_RATE_HZ;
    const receiving = acq.samplesReceived > this.lastTickSamples;
    this.lastTickSamples = acq.samplesReceived;
    void this.logger?.flush();
    void this.clip?.flush();
    this.update({
      samplesReceived: acq.samplesReceived,
      measuredRate: receiving ? acq.measuredRate() : null,
      gaps: acq.gaps.length,
      heart: heartRate(ecg),
      breathing: respPresent ? breathingRate(resp) : { value: null, reason: 'no respiration data' },
      contact: electrodeContact(ecg, resp),
      ...(this.ticks++ % ANALYSIS_EVERY_TICKS === 0
        ? { analysis: analyseEcg(acq.ecg.raw.read(end - ANALYSIS.windowS * SAMPLE_RATE_HZ, end).values) }
        : {}),
      respStatus: signalStatus(resp),
      respPresent,
      logging: this.logger ? { location: this.logger.location, seconds: this.logger.samplesWritten / SAMPLE_RATE_HZ } : null,
      loggingError: this.logger?.error ?? null,
      clip: this.clip ? { seconds: this.clip.seconds, maxSeconds: CLIP_SECONDS } : null,
    });
  }

  private update(patch: Partial<SessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l();
  }
}
