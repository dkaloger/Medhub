import { describe, expect, it } from 'vitest';
import { LineFramer, parseLine } from '../src/core/protocol';

describe('parseLine', () => {
  it('reads ECG + respiration lines exactly as the firmware sends them', () => {
    expect(parseLine('ECG:-695421\tRESP:1015296')).toEqual({ kind: 'sample', ecg: -695421, resp: 1015296 });
  });

  it('reads ECG-only firmware lines', () => {
    expect(parseLine('ECG:-217858\tZERO:0')).toEqual({ kind: 'sample', ecg: -217858, resp: null });
    expect(parseLine('ECG:123\r')).toEqual({ kind: 'sample', ecg: 123, resp: null });
  });

  it('passes status lines through', () => {
    expect(parseLine('READY_ELECTRODE_INPUT')).toEqual({ kind: 'message', text: 'READY_ELECTRODE_INPUT', isError: false });
    expect(parseLine('ERROR_ADS1292R_NOT_FOUND')).toMatchObject({ kind: 'message', isError: true });
  });

  it.each([
    '',
    'garbage',
    'RESP:12',
    'ECG:',
    'ECG:12abc\tRESP:1',
    'ECG:1\tRESP:x',
    'ECG:99999999', // outside the 24-bit range
    'ECG:1.5',
    'ets Jul 29 2019 12:21:46', // ESP32 boot ROM output
  ])('rejects %j', (line) => {
    expect(parseLine(line)).toBeNull();
  });
});

describe('LineFramer', () => {
  it('drops the first, possibly partial, line after connecting', () => {
    const framer = new LineFramer();
    expect(framer.push(('858\tRESP:1\nECG:1\tRESP:2\n'))).toEqual(['ECG:1\tRESP:2']);
  });

  it('holds a partial line until its newline arrives instead of emitting a truncated value', () => {
    const framer = new LineFramer();
    framer.push(('sync\n'));
    expect(framer.push(('ECG:-21'))).toEqual([]);
    expect(framer.push(('7858\tRESP:5\r\nECG:'))).toEqual(['ECG:-217858\tRESP:5']);
    expect(framer.push(('7\n'))).toEqual(['ECG:7']);
  });

  it('resynchronises after a long run of bytes without a newline', () => {
    const framer = new LineFramer();
    framer.push(('sync\n'));
    framer.push(('x'.repeat(LineFramer.MAX_LINE_LENGTH + 1)));
    expect(framer.push(('tail of noise\nECG:5\n'))).toEqual(['ECG:5']);
  });
});
