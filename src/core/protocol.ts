/**
 * The ESP32 firmware sends newline-terminated ASCII lines, over USB serial at 115200 baud
 * or as Bluetooth LE notifications (see docs/ble-protocol.md).
 *
 * Sample lines are whitespace-separated KEY:VALUE fields with ECG first:
 *   ECG:-217858<TAB>RESP:1015296   ECG plus respiration (ADS1292R CH1)
 *   ECG:-217858<TAB>ZERO:0         ECG-only firmware
 * Status lines start with READY_ or ERROR_.
 */
import { ADC_MAX, ADC_MIN } from './device';

export type ParsedLine =
  | { kind: 'sample'; ecg: number; resp: number | null }
  | { kind: 'message'; text: string; isError: boolean };

const INTEGER = /^[+-]?\d{1,8}$/;

function adcValue(text: string | undefined): number | null {
  if (text === undefined || !INTEGER.test(text)) return null;
  const value = Number(text);
  return value >= ADC_MIN && value <= ADC_MAX ? value : null;
}

/** Parse one complete line; anything malformed returns null rather than a guessed value. */
export function parseLine(raw: string): ParsedLine | null {
  const line = raw.trim();
  if (line.startsWith('READY_') || line.startsWith('ERROR_')) {
    return { kind: 'message', text: line, isError: line.startsWith('ERROR_') };
  }
  if (!line) return null;

  const fields = new Map<string, string>();
  for (const token of line.split(/\s+/)) {
    const colon = token.indexOf(':');
    if (colon <= 0) return null;
    fields.set(token.slice(0, colon), token.slice(colon + 1));
  }
  const ecg = adcValue(fields.get('ECG'));
  if (ecg === null) return null;
  let resp: number | null = null;
  if (fields.has('RESP')) {
    resp = adcValue(fields.get('RESP'));
    if (resp === null) return null;
  }
  return { kind: 'sample', ecg, resp };
}

/**
 * Turns a stream of text chunks into complete lines.
 *
 * A trailing partial line is held until its newline arrives, so a short read can never
 * turn "ECG:-217858" into "ECG:-21". The first line after (re)connecting is dropped
 * because the stream may have been joined mid-line.
 */
export class LineFramer {
  static readonly MAX_LINE_LENGTH = 256;
  private pending = '';
  private synced = false;

  push(chunk: string): string[] {
    this.pending += chunk;
    const lines = this.pending.split('\n');
    this.pending = lines.pop() ?? '';
    if (!this.synced && lines.length > 0) {
      lines.shift();
      this.synced = true;
    }
    if (this.pending.length > LineFramer.MAX_LINE_LENGTH) {
      // Noise without newlines (e.g. a baud mismatch): discard and resynchronise.
      this.pending = '';
      this.synced = false;
    }
    return lines.map((l) => l.trim()).filter((l) => l.length > 0);
  }

  reset(): void {
    this.pending = '';
    this.synced = false;
  }
}
