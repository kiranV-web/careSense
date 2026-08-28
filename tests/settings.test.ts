import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { CALL_ETIQUETTE_RULES, SettingsRepository } from '../src/db/settings.repository.js';

const settings = {
  recurring_lookback_days: 10,
  ideal_call_duration_seconds: 300,
  call_etiquette: [...CALL_ETIQUETTE_RULES],
  updated_at: new Date('2026-08-27T00:00:00Z')
};

describe('settings repository', () => {
  it('reads the singleton application settings row', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [settings] });
    const repository = new SettingsRepository({ query } as unknown as pg.Pool);

    await expect(repository.get()).resolves.toEqual(settings);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM application_settings WHERE id=1'));
  });

  it('updates settings without rebuilding recurrence when lookback is unchanged', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [settings] })
      .mockResolvedValueOnce({ rows: [{ ...settings, ideal_call_duration_seconds: 420 }] })
      .mockResolvedValueOnce({ rows: [] });
    const release = vi.fn();
    const client = { query, release };
    const repository = new SettingsRepository({ connect: vi.fn().mockResolvedValue(client) } as unknown as pg.Pool);

    const result = await repository.update({ recurring_lookback_days: 10, ideal_call_duration_seconds: 420 });

    expect(result.ideal_call_duration_seconds).toBe(420);
    expect(query).toHaveBeenCalledTimes(4);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM recurring_call_groups'))).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it('requeues analyzed calls when the recurrence window changes', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ...settings, recurring_lookback_days: 5 }] })
      .mockResolvedValueOnce({ rows: [settings] })
      .mockResolvedValue({ rows: [] });
    const release = vi.fn();
    const client = { query, release };
    const repository = new SettingsRepository({ connect: vi.fn().mockResolvedValue(client) } as unknown as pg.Pool);

    await repository.update({ recurring_lookback_days: 10 });

    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements.some((sql) => sql.includes('DELETE FROM recurring_call_groups'))).toBe(true);
    expect(statements.some((sql) => sql.includes('INSERT INTO recurrence_jobs'))).toBe(true);
    expect(statements.some((sql) => sql.includes("processing_state='LINKING_RECURRING_CALLS'"))).toBe(true);
    expect(statements.at(-1)).toBe('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });
});
