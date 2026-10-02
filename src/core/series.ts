/** Read-only access to samples by absolute sample index; NaN marks gaps or missing data. */
export interface SampleSeries {
  /** First index still available. */
  readonly start: number;
  /** One past the newest index. */
  readonly end: number;
  at(index: number): number;
}

/** Fixed-capacity buffer addressed by absolute sample index. Old samples fall off the front. */
export class RingBuffer implements SampleSeries {
  private readonly data: Float64Array;
  private _end = 0;

  constructor(readonly capacity: number) {
    this.data = new Float64Array(capacity).fill(NaN);
  }

  get end(): number {
    return this._end;
  }

  get start(): number {
    return Math.max(0, this._end - this.capacity);
  }

  at(index: number): number {
    if (index < this.start || index >= this._end) return NaN;
    return this.data[index % this.capacity];
  }

  push(values: ArrayLike<number>): void {
    let first = this._end;
    let offset = 0;
    let count = values.length;
    this._end += count;
    if (count > this.capacity) {
      offset = count - this.capacity;
      first += offset;
      count = this.capacity;
    }
    for (let i = 0; i < count; i++) this.data[(first + i) % this.capacity] = values[offset + i];
  }

  /** Advance by `count` missing samples without allocating them. */
  pushGap(count: number): void {
    if (count >= this.capacity) {
      this.data.fill(NaN);
    } else {
      for (let i = 0; i < count; i++) this.data[(this._end + i) % this.capacity] = NaN;
    }
    this._end += count;
  }

  /** Empty the buffer so that the next pushed sample gets index `end`. */
  reset(end: number): void {
    this.data.fill(NaN);
    this._end = end;
  }

  /** Copy of [start, stop) clamped to what is available. */
  read(start: number, stop: number): { start: number; values: Float64Array } {
    const from = Math.max(start, this.start);
    const to = Math.min(stop, this._end);
    const values = new Float64Array(Math.max(0, to - from));
    for (let i = 0; i < values.length; i++) values[i] = this.data[(from + i) % this.capacity];
    return { start: from, values };
  }
}

/** A complete in-memory signal, e.g. a recording loaded from disk. */
export class ArraySeries implements SampleSeries {
  constructor(
    readonly values: Float64Array,
    readonly start = 0,
  ) {}

  get end(): number {
    return this.start + this.values.length;
  }

  at(index: number): number {
    const i = index - this.start;
    return i >= 0 && i < this.values.length ? this.values[i] : NaN;
  }
}

/** Copy of [start, stop) from any series, NaN outside its range. */
export function readSeries(series: SampleSeries, start: number, stop: number): Float64Array {
  const out = new Float64Array(Math.max(0, stop - start));
  for (let i = 0; i < out.length; i++) out[i] = series.at(start + i);
  return out;
}
