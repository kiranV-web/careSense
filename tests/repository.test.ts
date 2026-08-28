import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { Repository } from '../src/db/repository.js';

describe('batch failure reasons', () => {
  it('atomically marks an active batch as user-cancelled', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ processing_state: 'TRANSCRIBING' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const release = vi.fn();
    const pool = { connect: vi.fn().mockResolvedValue({ query, release }) } as unknown as pg.Pool;
    const repository = new Repository(pool, 7);

    const result = await repository.cancelBatch('11111111-1111-4111-8111-111111111111');

    expect(result?.cancelled).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("processing_state='CANCELLED'"))).toBe(true);
    expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });

  it('stores ALL_CALLS_FAILED when no calls are accepted', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const repository = new Repository({ query } as unknown as pg.Pool, 7);

    await repository.completeBatch('batch-id', 8, 3, 3, 0);

    expect(query).toHaveBeenCalledOnce();
    const parameters = query.mock.calls[0]![1] as unknown[];
    expect(parameters[1]).toBe('FAILED');
    expect(parameters[6]).toBe('ALL_CALLS_FAILED');
    expect(JSON.parse(parameters[7] as string)).toMatchObject({
      message: 'The batch failed because no call recordings were accepted',
      invalid_pairs: 3
    });
  });

  it('stores ARCHIVE_PROCESSING_FAILED for an unreadable archive', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const repository = new Repository({ query } as unknown as pg.Pool, 7);

    await repository.failBatch('batch-id', 'Invalid ZIP central directory');

    expect(query).toHaveBeenCalledTimes(2);
    const parameters = query.mock.calls[0]![1] as unknown[];
    expect(JSON.parse(parameters[1] as string)).toEqual({ message: 'Invalid ZIP central directory' });
  });
});
