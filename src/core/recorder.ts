/**
 * Writes recordings through a platform-specific RecordingStore. Writes are queued and
 * batched; the first failure is kept in `error` and stops further writes instead of
 * throwing into the acquisition path.
 */
import { SAMPLE_RATE_HZ } from './device';
import { EVENTS_HEADER, SAMPLES_HEADER, eventRow, fileTimestamp, sampleRows } from './recordingFile';

export interface FileSink {
  readonly path: string;
  append(text: string): Promise<void>;
  close(): Promise<void>;
}

export interface RecordingStore {
  /** Human-readable location, e.g. a folder path. */
  readonly location: string;
  /** How many seconds of samples go into each continuous-log part file. */
  readonly partSeconds: number;
  /** Create a new file; the store picks a unique name if `fileName` already exists. */
  createFile(folder: readonly string[], fileName: string): Promise<FileSink>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class QueuedFile {
  private sink: FileSink | null = null;
  private pending = '';
  private chain: Promise<void> = Promise.resolve();
  error: string | null = null;

  constructor(
    private readonly store: RecordingStore,
    private readonly folder: readonly string[],
    private readonly fileName: string,
    private readonly header: string,
  ) {}

  get path(): string {
    return this.sink?.path ?? [this.store.location, ...this.folder, this.fileName].join('/');
  }

  write(text: string): void {
    if (!this.error) this.pending += text;
  }

  flush(): Promise<void> {
    const text = this.pending;
    this.pending = '';
    if (!text || this.error) return this.chain;
    this.chain = this.chain
      .then(async () => {
        if (this.error) return;
        if (!this.sink) {
          this.sink = await this.store.createFile(this.folder, this.fileName);
          await this.sink.append(this.header);
        }
        await this.sink.append(text);
      })
      .catch((e) => {
        this.error ??= message(e);
      });
    return this.chain;
  }

  close(): Promise<void> {
    void this.flush();
    this.chain = this.chain
      .then(() => this.sink?.close())
      .catch((e) => {
        this.error ??= message(e);
      });
    return this.chain;
  }
}

/** Continuous log of every sample in rotating part files, plus an events file. */
export class SessionLogger {
  readonly folder: string;
  samplesWritten = 0;
  private readonly files: QueuedFile[] = [];
  private readonly events: QueuedFile;
  private part: QueuedFile | null = null;
  private partNumber = 0;
  private partRows = 0;
  private readonly partSamples: number;
  private closing: Promise<void>[] = [];

  constructor(
    private readonly store: RecordingStore,
    simulated: boolean,
    started = new Date(),
    private readonly fs = SAMPLE_RATE_HZ,
  ) {
    this.folder = `${simulated ? 'simulated' : 'session'}_${fileTimestamp(started)}`;
    this.partSamples = Math.round(store.partSeconds * fs);
    this.events = this.open('events.csv', EVENTS_HEADER);
  }

  get location(): string {
    return [this.store.location, this.folder].join('/');
  }

  get error(): string | null {
    return this.files.find((f) => f.error)?.error ?? null;
  }

  write(firstIndex: number, ecg: Float64Array, resp: Float64Array): void {
    let offset = 0;
    while (offset < ecg.length) {
      if (!this.part || this.partRows >= this.partSamples) this.rotate();
      const take = Math.min(ecg.length - offset, this.partSamples - this.partRows);
      this.part!.write(
        sampleRows(firstIndex + offset, ecg.subarray(offset, offset + take), resp.subarray(offset, offset + take), this.fs),
      );
      this.partRows += take;
      this.samplesWritten += take;
      offset += take;
    }
  }

  event(index: number, text: string, at = new Date()): void {
    this.events.write(eventRow(index, text, at, this.fs));
  }

  async flush(): Promise<void> {
    await Promise.all([this.part?.flush(), this.events.flush()]);
  }

  async close(): Promise<void> {
    await Promise.all([...this.closing, this.part?.close(), this.events.close()]);
  }

  private open(fileName: string, header: string): QueuedFile {
    const file = new QueuedFile(this.store, [this.folder], fileName, header);
    this.files.push(file);
    return file;
  }

  private rotate(): void {
    if (this.part) this.closing.push(this.part.close());
    this.partNumber += 1;
    this.partRows = 0;
    this.part = this.open(`part_${String(this.partNumber).padStart(4, '0')}.csv`, SAMPLES_HEADER);
  }
}

/** A single user-triggered clip that stops itself after `maxSeconds`. */
export class ClipRecorder {
  samples = 0;
  readonly maxSamples: number;
  private readonly file: QueuedFile;

  constructor(
    store: RecordingStore,
    simulated: boolean,
    maxSeconds: number,
    started = new Date(),
    private readonly fs = SAMPLE_RATE_HZ,
  ) {
    this.maxSamples = Math.round(maxSeconds * fs);
    const name = `${simulated ? 'simulated' : 'ecg'}_clip_${fileTimestamp(started)}.csv`;
    this.file = new QueuedFile(store, ['clips'], name, SAMPLES_HEADER);
  }

  get seconds(): number {
    return this.samples / this.fs;
  }

  get full(): boolean {
    return this.samples >= this.maxSamples;
  }

  get error(): string | null {
    return this.file.error;
  }

  get path(): string {
    return this.file.path;
  }

  /** Returns true once the clip has reached its maximum length. */
  write(firstIndex: number, ecg: Float64Array, resp: Float64Array): boolean {
    const take = Math.min(ecg.length, this.maxSamples - this.samples);
    if (take > 0) {
      this.file.write(sampleRows(firstIndex, ecg.subarray(0, take), resp.subarray(0, take), this.fs));
      this.samples += take;
    }
    return this.full;
  }

  flush(): Promise<void> {
    return this.file.flush();
  }

  close(): Promise<void> {
    return this.file.close();
  }
}
