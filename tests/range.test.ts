import { describe, expect, it } from 'vitest';
import { parseByteRange } from '../src/api/range.js';

describe('audio byte ranges', () => {
  it('parses bounded, open-ended, and suffix ranges', () => {
    expect(parseByteRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
    expect(parseByteRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
  });

  it('rejects invalid or unsatisfiable ranges', () => {
    expect(() => parseByteRange('bytes=100-120', 100)).toThrow('INVALID_RANGE');
    expect(() => parseByteRange('items=0-1', 100)).toThrow('INVALID_RANGE');
  });
});
