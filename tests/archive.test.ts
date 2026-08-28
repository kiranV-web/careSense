import { describe, expect, it } from 'vitest';
import { isMacOsMetadataPath, isSafeZipPath } from '../src/services/archive.js';

describe('ZIP path safety', () => {
  it('recognizes macOS resource-fork entries as ignorable metadata', () => {
    expect(isMacOsMetadataPath('__MACOSX/allrec/._conv1.mp3')).toBe(true);
    expect(isMacOsMetadataPath('allrec/conv1.mp3')).toBe(false);
  });

  it.each(['Conv1.mp3', 'folder/Conv1_meta.json'])('accepts safe path %s', (filename) => {
    expect(isSafeZipPath(filename)).toBe(true);
  });

  it.each(['../secret.mp3', '/etc/passwd', 'folder/../../secret.wav', 'folder\\file.mp3'])
    ('rejects unsafe path %s', (filename) => {
      expect(isSafeZipPath(filename)).toBe(false);
    });
});
