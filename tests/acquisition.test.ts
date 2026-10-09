import { describe, expect, it } from 'vitest';
import { Acquisition } from '../src/core/acquisition';
import { SAMPLE_RATE_HZ } from '../src/core/device';
import { ecgDisplayChain, respDisplayChain } from '../src/core/filters';
import { RingBuffer } from '../src/core/series';

const fs = SAMPLE_RATE_HZ;
const batch = (n: number, receivedAt: number, value = 1, resp = NaN) => ({
  ecg: new Float64Array(n).fill(value),
  resp: new Float64Array(n).fill(resp),
  receivedAt,
});

describe('RingBuffer', () => {
  it('keeps the newest samples by absolute index across wrap-around', () => {
    const ring = new RingBuffer(5);
    ring.push([0, 1, 2, 3]);
    ring.push([4, 5, 6]);
    expect([ring.start, ring.end]).toEqual([2, 7]);
    expect(Array.from(ring.read(0, 100).values)).toEqual([2, 3, 4, 5, 6]);
    expect(ring.read(0, 100).start).toBe(2);
    expect(ring.at(1)).toBeNaN();
    ring.push([7, 8, 9, 10, 11, 12, 13]);
    expect(Array.from(ring.read(0, 100).values)).toEqual([9, 10, 11, 12, 13]);
  });

  it('finds the extent of a range across the wrap-around, skipping gaps', () => {
    const ring = new RingBuffer(5);
    ring.push([9, 1, 2, NaN, 7, 3, -4]); // holds indices 2..6: 2, NaN, 7, 3, -4
    const out = new Float64Array(2);
    expect(ring.extent(0, 100, out)).toBe(true);
    expect(Array.from(out)).toEqual([-4, 7]);
    expect(ring.extent(3, 4, out)).toBe(false);
    expect(ring.extent(5, 6, out) && Array.from(out)).toEqual([3, 3]);
  });

  it('records gaps as NaN without allocating them', () => {
    const ring = new RingBuffer(4);
    ring.push([1, 2]);
    ring.pushGap(1_000_000);
    ring.push([3]);
    expect(ring.end).toBe(1_000_003);
    expect(Array.from(ring.read(0, ring.end).values)).toEqual([NaN, NaN, NaN, 3]);
  });
});

describe('Acquisition', () => {
  it('keeps steady streams gap-free despite arrival jitter and bursts', () => {
    const acq = new Acquisition(10 * fs);
    let t = 0;
    for (let i = 0; i < 100; i++) {
      t += i % 10 === 0 ? 300 : 10; // occasional 300 ms stall followed by a catch-up burst
      acq.ingest(batch(i % 10 === 0 ? 75 : 3, t));
    }
    expect(acq.gaps).toEqual([]);
  });

  it('inserts an estimated gap when the device goes quiet', () => {
    const acq = new Acquisition(60 * fs);
    const events: string[] = [];
    acq.subscribe({ event: (_i, text) => events.push(text) });
    acq.ingest(batch(250, 1000));
    acq.ingest(batch(25, 11_100)); // ~10 s later, only 0.1 s of samples
    expect(acq.gaps).toEqual([{ index: 250, count: 2500 }]);
    expect(acq.end).toBe(250 + 2500 + 25);
    expect(acq.ecg.raw.at(300)).toBeNaN();
    expect(acq.ecg.raw.at(acq.end - 1)).toBe(1);
    expect(events[0]).toMatch(/Gap of about 10\.0 s/);
  });

  it('measures the actual sample rate', () => {
    const acq = new Acquisition(fs);
    for (let i = 0; i <= 40; i++) acq.ingest(batch(10, i * 40));
    expect(acq.measuredRate()).toBeCloseTo(250, 5);
  });

  it('notifies listeners with the absolute index of every sample', () => {
    const acq = new Acquisition(fs);
    const seen: number[] = [];
    acq.subscribe({ samples: (first, ecg) => seen.push(first, ecg.length) });
    acq.ingest(batch(3, 0));
    acq.ingest(batch(2, 10));
    expect(seen).toEqual([0, 3, 3, 2]);
  });

  it('re-filters the whole buffer when the display filter changes', () => {
    const acq = new Acquisition(4 * fs);
    acq.ingest(batch(fs, 0, -700_000, 1_000_000));
    acq.ecg.setFilter(ecgDisplayChain('monitor', 'hz50'));
    acq.resp.setFilter(respDisplayChain('lowpass2'));
    expect(acq.ecg.display.at(fs - 1)).toBeCloseTo(0, 6);
    expect(acq.resp.display.at(fs - 1)).toBeCloseTo(1_000_000, 6);
    expect(acq.ecg.display.end).toBe(acq.ecg.raw.end);
    expect(acq.resp.lastFiniteIndex).toBe(fs - 1);
  });

  it('keeps a filtered trace stable as old samples scroll out of the buffer', () => {
    // Regression for the Python viewer, whose respiration trace jumped every frame once full.
    const acq = new Acquisition(2 * fs);
    acq.resp.setFilter(respDisplayChain('lowpass2'));
    const sine = Float64Array.from({ length: 20 * fs }, (_, i) => 1_000_000 + 1000 * Math.sin((2 * Math.PI * 0.25 * i) / fs));
    for (let i = 0; i < sine.length; i += 10) {
      acq.ingest({ ecg: new Float64Array(10), resp: sine.slice(i, i + 10), receivedAt: i * 4 });
    }
    // Every buffered value equals filtering the full history once, whatever has scrolled out.
    const reference = respDisplayChain('lowpass2').process(sine);
    for (let i = acq.resp.display.start; i < acq.end; i++) {
      expect(acq.resp.display.at(i)).toBeCloseTo(reference[i], 6);
    }
  });
});
