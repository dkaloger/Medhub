import { describe, expect, it } from 'vitest';
import { ClipRecorder, SessionLogger, type FileSink, type RecordingStore } from '../src/core/recorder';
import { parseRecording, sampleRows } from '../src/core/recordingFile';

class MemoryStore implements RecordingStore {
  readonly location = 'mem';
  readonly files = new Map<string, string>();
  closed: string[] = [];
  failAfter = Infinity;

  constructor(readonly partSeconds = 600) {}

  async createFile(folder: readonly string[], fileName: string): Promise<FileSink> {
    let path = [...folder, fileName].join('/');
    for (let n = 2; this.files.has(path); n++) path = [...folder, fileName.replace('.csv', `-${n}.csv`)].join('/');
    this.files.set(path, '');
    return {
      path,
      append: async (text) => {
        if (--this.failAfter < 0) throw new Error('disk full');
        this.files.set(path, this.files.get(path) + text);
      },
      close: async () => {
        this.closed.push(path);
      },
    };
  }
}

const f64 = (...v: number[]) => Float64Array.from(v);

describe('CSV rows', () => {
  it('writes the sample index, time and blank respiration when absent', () => {
    expect(sampleRows(250, f64(-5, 7), f64(NaN, 9))).toBe('250,1.000,-5,\n251,1.004,7,9\n');
  });
});

describe('SessionLogger', () => {
  it('rotates part files and writes an events file', async () => {
    const store = new MemoryStore(0.02); // 5 samples per part
    const logger = new SessionLogger(store, false, new Date(2026, 9, 2, 15, 6, 47));
    logger.event(0, 'Connected to "ESP32"');
    logger.write(0, f64(1, 2, 3, 4), f64(NaN, NaN, NaN, NaN));
    await logger.flush();
    logger.write(4, f64(5, 6, 7), f64(1, 2, 3));
    await logger.close();

    expect(logger.folder).toBe('session_20261002_150647');
    const part1 = store.files.get('session_20261002_150647/part_0001.csv')!;
    const part2 = store.files.get('session_20261002_150647/part_0002.csv')!;
    expect(part1.trim().split('\n')).toHaveLength(6);
    expect(part2).toBe('sample_index,time_s,ecg_counts,resp_counts\n5,0.020,6,2\n6,0.024,7,3\n');
    expect(store.files.get('session_20261002_150647/events.csv')).toMatch(/0,0\.000,.*,"Connected to ""ESP32"""/);
    expect(store.closed).toHaveLength(3);
    expect(logger.samplesWritten).toBe(7);
  });

  it('reports a write failure instead of throwing', async () => {
    const store = new MemoryStore();
    store.failAfter = 1;
    const logger = new SessionLogger(store, true);
    logger.write(0, f64(1), f64(NaN));
    await logger.flush();
    expect(logger.error).toBe('disk full');
    logger.write(1, f64(2), f64(NaN));
    await expect(logger.close()).resolves.toBeUndefined();
  });
});

describe('ClipRecorder', () => {
  it('stops at its maximum length and never overwrites an existing clip', async () => {
    const store = new MemoryStore();
    const started = new Date(2026, 9, 2, 15, 0, 0);
    const first = new ClipRecorder(store, false, 0.012, started); // 3 samples
    expect(first.write(10, f64(1, 2), f64(NaN, NaN))).toBe(false);
    expect(first.write(12, f64(3, 4), f64(NaN, NaN))).toBe(true);
    await first.close();
    const second = new ClipRecorder(store, false, 1, started);
    second.write(0, f64(9), f64(NaN));
    await second.close();
    expect([...store.files.keys()]).toEqual(['clips/ecg_clip_20261002_150000.csv', 'clips/ecg_clip_20261002_150000-2.csv']);
    expect(parseRecording(store.files.get('clips/ecg_clip_20261002_150000.csv')!, 'clip').ecg).toEqual(f64(1, 2, 3));
  });
});

describe('parseRecording', () => {
  it('restores gaps and session timing', () => {
    const text = 'sample_index,time_s,ecg_counts,resp_counts\n100,0.400,1,\n101,0.404,2,5\n104,0.416,3,6\n';
    const rec = parseRecording(text, 'part_0001.csv');
    expect(rec.startIndex).toBe(100);
    expect(Array.from(rec.ecg)).toEqual([1, 2, NaN, NaN, 3]);
    expect(rec.hasResp).toBe(true);
    expect(rec.gapCount).toBe(1);
  });

  it('reads files from the original Python viewer', () => {
    const rec = parseRecording('time_s,ecg_adc_counts,resp_adc_counts\n0.000,100,\n0.004,-50,250\n', 'simulated_x.csv');
    expect(Array.from(rec.ecg)).toEqual([100, -50]);
    expect(Array.from(rec.resp)).toEqual([NaN, 250]);
    expect(rec.simulated).toBe(true);
  });

  it('rejects files that are not recordings', () => {
    expect(() => parseRecording('a,b\n1,2\n', 'x.csv')).toThrow(/Not a Medhub recording/);
    expect(() => parseRecording('sample_index,ecg_counts\n5,1\n4,1\n', 'x.csv')).toThrow(/out of time order/);
  });
});
