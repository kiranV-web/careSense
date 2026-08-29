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

  it('includes recurring, rude and unresolved calls in the attention filter', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [] });
    const repository = new CallRepository({ query } as unknown as pg.Pool);

    await repository.listGrouped(1, 15, undefined, undefined, 'attention');

    const sql = String(query.mock.calls[0]![0]);
    expect(sql).toContain("'RECURRING'=ANY(c.call_statuses)");
    expect(sql).toContain("'RUDE'=ANY(c.call_statuses)");
    expect(sql).toContain("c.resolution_status='UNRESOLVED'");
    expect(sql).toContain('FROM recurring_call_groups g\n         WHERE true');
  });
});

describe('customer call history', () => {
  it('returns paginated customers with outcome-labelled activity', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: 'customer-1', external_id: 'CUSTOMER-1', logged_names: ['Asha', 'Asha Rao'], call_count: 2,
        resolved_count: 1, improve_quality_count: 0, attention_count: 1, dropped_count: 0,
        total_duration_seconds: '135', latest_call_at: '2026-08-21T10:00:00.000Z', total_count: 1
      }] })
      .mockResolvedValueOnce({ rows: [
        { id: 'call-1', customer_id: 'customer-1', agent_id: 'agent-1', external_call_id: 'CALL-1',
          started_at: '2026-08-20T10:00:00.000Z', resolution_status: 'UNRESOLVED', call_statuses: [],
          needs_manager_attention: true },
        { id: 'call-2', customer_id: 'customer-1', agent_id: 'agent-1', external_call_id: 'CALL-2',
          started_at: '2026-08-21T10:00:00.000Z', resolution_status: 'RESOLVED', call_statuses: [],
          needs_manager_attention: false }
      ] });
    const repository = new CallRepository({ query } as unknown as pg.Pool);

    const result = await repository.listCustomers(undefined, 1, 12) as any;

    expect(result.pagination).toEqual({ page: 1, page_size: 12, total: 1, total_pages: 1 });
    expect(result.items[0]).toMatchObject({ id: 'customer-1', call_count: 2, logged_names: ['Asha', 'Asha Rao'] });
    expect(result.items[0].activity).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'call-1', status: 'unresolved', status_label: 'Unresolved' }),
      expect.objectContaining({ id: 'call-2', status: 'resolved', status_label: 'Resolved' })
    ]));
  });

  it('returns a customer and only that customer calls', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: 'customer-1', external_id: 'CUSTOMER-1', logged_names: ['Asha'], call_count: 1,
        resolved_count: 1, improve_quality_count: 0, attention_count: 0, dropped_count: 0,
        total_duration_seconds: '88', latest_call_at: '2026-08-21T10:00:00.000Z'
      }] })
      .mockResolvedValueOnce({ rows: [{
        id: 'call-1', external_call_id: 'CALL-1', resolution_status: 'RESOLVED', call_statuses: [],
        total_count: 1
      }] });
    const repository = new CallRepository({ query } as unknown as pg.Pool);

    const result = await repository.getCustomerCalls('customer-1', 1, 15) as any;

    expect(result.customer).toMatchObject({ id: 'customer-1', logged_names: ['Asha'] });
    expect(result.items[0]).toMatchObject({ id: 'call-1', status: 'resolved', status_label: 'Resolved' });
    expect(query.mock.calls[1]![1]).toContain('customer-1');
  });
});
