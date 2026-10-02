/**
 * CSV format for recordings:
 *   sample_index,time_s,ecg_counts,resp_counts
 * sample_index counts from the start of the session and skips over gaps, so a jump in
 * sample_index (and time_s) marks a dropout. resp_counts is empty when not sent.
 *
 * Files from the original Python viewer (time_s,ecg_adc_counts,resp_adc_counts) also load.
 */
import { SAMPLE_RATE_HZ } from './device';

export const SAMPLES_HEADER = 'sample_index,time_s,ecg_counts,resp_counts\n';
export const EVENTS_HEADER = 'sample_index,time_s,wall_clock,event\n';

/** Longest recording we will expand into memory (4 h at 250 Hz). */
const MAX_SPAN_SAMPLES = 4 * 3600 * SAMPLE_RATE_HZ;

export function sampleRows(
  firstIndex: number,
  ecg: ArrayLike<number>,
  resp: ArrayLike<number>,
  fs = SAMPLE_RATE_HZ,
): string {
  let out = '';
  for (let i = 0; i < ecg.length; i++) {
    const index = firstIndex + i;
    const r = resp[i];
    out += `${index},${(index / fs).toFixed(3)},${ecg[i]},${Number.isFinite(r) ? r : ''}\n`;
  }
  return out;
}

export function eventRow(index: number, text: string, at: Date, fs = SAMPLE_RATE_HZ): string {
  return `${index},${(index / fs).toFixed(3)},${at.toISOString()},"${text.replace(/"/g, '""')}"\n`;
}

export function fileTimestamp(date: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}_` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

export interface Recording {
  name: string;
  /** Session sample index of the first value, so times match the original session. */
  startIndex: number;
  ecg: Float64Array;
  resp: Float64Array;
  hasResp: boolean;
  simulated: boolean;
  gapCount: number;
}

function column(header: string[], ...names: string[]): number {
  for (const name of names) {
    const i = header.indexOf(name);
    if (i >= 0) return i;
  }
  return -1;
}

export function parseRecording(text: string, name: string, fs = SAMPLE_RATE_HZ): Recording {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) throw new Error('The file has no samples.');
  const header = lines[0].split(',').map((h) => h.trim());
  const indexCol = column(header, 'sample_index');
  const timeCol = column(header, 'time_s');
  const ecgCol = column(header, 'ecg_counts', 'ecg_adc_counts');
  const respCol = column(header, 'resp_counts', 'resp_adc_counts');
  if (ecgCol < 0 || (indexCol < 0 && timeCol < 0)) {
    throw new Error('Not a Medhub recording: expected sample_index/time_s and ecg_counts columns.');
  }

  const indices: number[] = [];
  const ecg: number[] = [];
  const resp: number[] = [];
  for (let row = 1; row < lines.length; row++) {
    const cells = lines[row].split(',');
    const index = indexCol >= 0 ? Number(cells[indexCol]) : Math.round(Number(cells[timeCol]) * fs);
    const e = Number(cells[ecgCol]);
    if (!Number.isInteger(index) || !Number.isFinite(e)) throw new Error(`Malformed row ${row + 1}.`);
    if (indices.length && index <= indices[indices.length - 1]) {
      throw new Error(`Row ${row + 1} is out of time order.`);
    }
    const r = respCol >= 0 ? cells[respCol]?.trim() : '';
    indices.push(index);
    ecg.push(e);
    resp.push(r ? Number(r) : NaN);
  }

  const startIndex = indices[0];
  const span = indices[indices.length - 1] - startIndex + 1;
  if (span > MAX_SPAN_SAMPLES) throw new Error('Recording spans more than 4 hours; split it first.');
  const ecgOut = new Float64Array(span).fill(NaN);
  const respOut = new Float64Array(span).fill(NaN);
  let gapCount = 0;
  indices.forEach((index, i) => {
    if (i > 0 && index !== indices[i - 1] + 1) gapCount++;
    ecgOut[index - startIndex] = ecg[i];
    respOut[index - startIndex] = resp[i];
  });
  return {
    name,
    startIndex,
    ecg: ecgOut,
    resp: respOut,
    hasResp: resp.some(Number.isFinite),
    simulated: name.startsWith('simulated'),
    gapCount,
  };
}
