import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { CallRepository } from '../src/db/call.repository.js';

describe('grouped call list', () => {
  it('returns one recurring row with ordered member previews', async () => {
    const calls = [
      { sequence_number: 1, id: 'call-1', title: 'First attempt', resolution_status: 'UNRESOLVED' },
      { sequence_number: 2, id: 'call-2', title: 'Second attempt', resolution_status: 'UNRESOLVED' },
      { sequence_number: 3, id: 'call-3', title: 'Issue fixed', resolution_status: 'RESOLVED' }
    ];
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ item_type: 'RECURRING_GROUP', id: 'group-1', total_count: 1 }] })
      .mockResolvedValueOnce({ rows: [{
        item_type: 'RECURRING_GROUP', id: 'group-1', title: 'Repeated mobile data issue',
        call_count: 3, calls
      }] });
    const repository = new CallRepository({ query } as unknown as pg.Pool);

    const result = await repository.listGrouped(1, 8);

    expect(result.pagination.total).toBe(1);
    expect(result.items[0]).toMatchObject({ item_type: 'RECURRING_GROUP', call_count: 3, calls });
    expect(String(query.mock.calls[1]![0])).toContain('ORDER BY m.sequence_number');
  });

  it('includes attention calls and their recurring group rows in the attention filter', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] });
    const repository = new CallRepository({ query } as unknown as pg.Pool);

    await repository.listGrouped(1, 15, undefined, undefined, 'attention');

    const sql = String(query.mock.calls[0]![0]);
    expect(sql).toContain('c.needs_manager_attention');
    expect(sql).toContain('attention_member.recurring_group_id=g.id');
    expect(sql).toContain('attention_call.needs_manager_attention');
  });
});
