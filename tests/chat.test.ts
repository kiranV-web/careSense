import { describe, expect, it } from 'vitest';
import { finalAnswerSchema } from '../src/services/chat.js';

describe('chat final answer schema', () => {
  it('accepts an answer with a populated table', () => {
    const result = finalAnswerSchema.safeParse({
      answer: 'Michael has the highest quality score at 91%.',
      cited_external_call_ids: [],
      table: {
        title: 'Agents ranked by quality score',
        columns: ['Agent', 'Quality score', 'Calls'],
        rows: [['Michael', '91%', '37'], ['Jennifer', '91%', '34']]
      }
    });
    expect(result.success).toBe(true);
  });

  it('accepts an answer with no table', () => {
    const result = finalAnswerSchema.safeParse({
      answer: 'There are 289 calls in total.',
      cited_external_call_ids: [],
      table: null
    });
    expect(result.success).toBe(true);
  });

  it('rejects a table with mismatched or missing fields', () => {
    const result = finalAnswerSchema.safeParse({
      answer: 'Bad table.',
      cited_external_call_ids: [],
      table: { title: 'Missing columns', rows: [['a']] }
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown top-level field', () => {
    const result = finalAnswerSchema.safeParse({
      answer: 'Extra field.',
      cited_external_call_ids: [],
      table: null,
      confidence: 0.9
    });
    expect(result.success).toBe(false);
  });
});
