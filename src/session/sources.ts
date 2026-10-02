import type { SampleBatch } from '../core/acquisition';
import { parseLine } from '../core/protocol';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';

export type SourceEvent =
  | { type: 'batch'; batch: SampleBatch }
  | { type: 'state'; state: ConnectionState; detail: string }
  | { type: 'message'; text: string; isError: boolean };

export interface SampleSource {
  readonly label: string;
  readonly simulated: boolean;
  start(emit: (event: SourceEvent) => void): void;
  stop(): Promise<void>;
}

/** Parses complete lines into one batch, emitting device messages in stream order. */
export function emitLines(lines: string[], receivedAt: number, emit: (event: SourceEvent) => void): void {
  const ecg: number[] = [];
  const resp: number[] = [];
  const flush = () => {
    if (ecg.length === 0) return;
    emit({ type: 'batch', batch: { ecg: Float64Array.from(ecg), resp: Float64Array.from(resp), receivedAt } });
    ecg.length = 0;
    resp.length = 0;
  };
  for (const line of lines) {
    const parsed = parseLine(line);
    if (parsed?.kind === 'sample') {
      ecg.push(parsed.ecg);
      resp.push(parsed.resp ?? NaN);
    } else if (parsed?.kind === 'message') {
      flush();
      emit({ type: 'message', text: parsed.text, isError: parsed.isError });
    }
  }
  flush();
}
