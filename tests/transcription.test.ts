import { describe, expect, it } from 'vitest';
import { normalizeDiarizedTranscript, TranscriptionContractError } from '../src/services/transcription.js';

describe('diarized transcript normalization', () => {
  it('maps the first voice to the metadata agent and the second to the customer', () => {
    const result = normalizeDiarizedTranscript({
      language: 'en', duration: 9.5,
      segments: [
        { speaker: 'A', start: 0.5, end: 3.2, text: 'Welcome to bank support.' },
        { speaker: 'B', start: 3.4, end: 6.8, text: 'My notifications are missing.' },
        { speaker: 'A', start: 7.0, end: 9.5, text: 'I can help with that.' }
      ]
    }, 'Maya', 'Anjali Nair');

    expect(result.segments.map((segment) => [segment.speaker_role, segment.speaker_name])).toEqual([
      ['AGENT', 'Maya'], ['CUSTOMER', 'Anjali Nair'], ['AGENT', 'Maya']
    ]);
    expect(result.fullText).toBe('Welcome to bank support.\nMy notifications are missing.\nI can help with that.');
  });

  it('uses default names when metadata names are absent', () => {
    const result = normalizeDiarizedTranscript({ segments: [
      { speaker: 0, start: 0, end: 1, text: 'Hello.' },
      { speaker: 1, start: 1, end: 2, text: 'Hi.' }
    ] });
    expect(result.segments[0]?.speaker_name).toBe('Agent');
    expect(result.segments[1]?.speaker_name).toBe('Customer');
  });

  it('rejects unexpected third-speaker diarization', () => {
    expect(() => normalizeDiarizedTranscript({ segments: [
      { speaker: 'A', start: 0, end: 1, text: 'One' },
      { speaker: 'B', start: 1, end: 2, text: 'Two' },
      { speaker: 'C', start: 2, end: 3, text: 'Three' }
    ] })).toThrowError(expect.objectContaining<Partial<TranscriptionContractError>>({ code: 'DIARIZATION_INCONSISTENT' }));
  });
});
