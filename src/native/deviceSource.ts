import { NativeEventEmitter, type EmitterSubscription } from 'react-native';
import { LineFramer } from '../core/protocol';
import { emitLines, type SampleSource, type SourceEvent } from '../session/sources';
import { base64ToLatin1 } from './base64';
import { requireNative, DATA_EVENT, STATE_EVENT, type DataEvent, type DeviceInfo, type StateEvent } from './NativeMedhub';

const RECONNECT_DELAY_MS = 2000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A board connected over USB serial or Bluetooth LE through the native module.
 * If the device goes away it keeps retrying until stopped; Acquisition marks the dropout.
 */
export class DeviceSource implements SampleSource {
  readonly simulated = false;
  readonly label: string;
  private readonly emitter = new NativeEventEmitter(requireNative());
  private subscriptions: EmitterSubscription[] = [];
  private framer = new LineFramer();
  private stopped = false;
  private retry: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly device: DeviceInfo) {
    this.label = `${device.name} (${device.transport === 'ble' ? 'Bluetooth' : 'USB'})`;
  }

  start(emit: (event: SourceEvent) => void): void {
    this.subscriptions = [
      this.emitter.addListener(DATA_EVENT, (event: DataEvent) => {
        emitLines(this.framer.push(base64ToLatin1(event.data)), event.t, emit);
      }),
      this.emitter.addListener(STATE_EVENT, (event: StateEvent) => {
        if (this.stopped) return;
        emit({ type: 'state', state: event.state, detail: event.detail });
        if (event.state === 'disconnected' && event.lost) this.scheduleReconnect(emit);
      }),
    ];
    void this.open(emit);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.subscriptions.forEach((s) => s.remove());
    this.subscriptions = [];
    await requireNative().disconnect().catch(() => undefined);
  }

  private async open(emit: (event: SourceEvent) => void): Promise<void> {
    if (this.stopped) return;
    this.framer = new LineFramer();
    emit({ type: 'state', state: 'connecting', detail: `Connecting to ${this.label}…` });
    try {
      await requireNative().connect(this.device.id);
    } catch (error) {
      if (this.stopped) return;
      emit({ type: 'state', state: 'disconnected', detail: `${this.label}: ${errorText(error)}` });
      this.scheduleReconnect(emit);
    }
  }

  private scheduleReconnect(emit: (event: SourceEvent) => void): void {
    if (this.stopped || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      void this.open(emit);
    }, RECONNECT_DELAY_MS);
  }
}
