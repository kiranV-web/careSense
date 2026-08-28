export interface ByteRange { start: number; end: number }

export function parseByteRange(header: string | undefined, totalBytes: number): ByteRange | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (!match || totalBytes <= 0) throw new Error('INVALID_RANGE');
  const [, startText, endText] = match;
  if (!startText && !endText) throw new Error('INVALID_RANGE');
  let start: number;
  let end: number;
  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new Error('INVALID_RANGE');
    start = Math.max(0, totalBytes - suffix);
    end = totalBytes - 1;
  } else {
    start = Number(startText);
    end = endText ? Number(endText) : totalBytes - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= totalBytes || end < start) {
    throw new Error('INVALID_RANGE');
  }
  return { start, end: Math.min(end, totalBytes - 1) };
}
