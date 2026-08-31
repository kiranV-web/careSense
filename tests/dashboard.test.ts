import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { DashboardRepository } from '../src/db/dashboard.repository.js';

const period = { date: '2026-08-20', timezone: 'Asia/Kolkata' };
const teamPeriod = { ...period, dateFrom: '2026-06-01', dateTo: '2026-08-20' };

describe('dashboard repository', () => {
  it('builds home metrics and keeps overlapping statuses independent', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        calls_today: 10, calls_yesterday: 8, avg_duration_seconds: '274.4',
        resolved_count: 8, recurring_count: 3, rude_count: 2, unresolved_count: 1, attention_count: 2
      }] })
      .mockResolvedValueOnce({ rows: [
        { day: '2026-08-17', day_name: 'Mon', count: 1 }, { day: '2026-08-18', day_name: 'Tue', count: 2 },
        { day: '2026-08-19', day_name: 'Wed', count: 3 }, { day: '2026-08-20', day_name: 'Thu', count: 10 },
        { day: '2026-08-21', day_name: 'Fri', count: 0 }, { day: '2026-08-22', day_name: 'Sat', count: 0 },
        { day: '2026-08-23', day_name: 'Sun', count: 0 }
      ] })
      .mockResolvedValueOnce({ rows: [
        { banking_product: 'CURRENT_ACCOUNT', call_count: 9, percent_of_highest: '100' },
        { banking_product: 'GENERAL_BANKING', call_count: 1, percent_of_highest: '11.11' }
      ] })
      .mockResolvedValueOnce({ rows: [{ issue_category: 'BATTERY_DRAIN', call_count: 4, percent_of_highest: '100' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'call-1', duration_seconds: '120.5', call_statuses: ['RUDE'] }] })
      .mockResolvedValueOnce({ rows: [{ ideal_call_duration_seconds: 300 }] });
    const repository = new DashboardRepository({ query } as unknown as pg.Pool);

    const result = await repository.getHome(period) as any;

    expect(result.calls_today).toEqual({ count: 10, yesterday_count: 8, delta_percent: 25 });
    expect(result.average_duration).toEqual({ seconds: 274, target_seconds: 300, difference_seconds: -26 });
    expect(result.rates).toMatchObject({
      denominator: 10,
      resolved: { count: 8, percent: 80 },
      recurring: { count: 3, percent: 30 },
      rude: { count: 2, percent: 20 }
    });
    expect(result.banking_products[1]).toMatchObject({ banking_product: 'GENERAL_BANKING', call_count: 1 });
    expect(result.weekly_calls).toMatchObject({ total: 16, peak_day: '2026-08-20' });
    expect(result.flagged_calls[0].duration_seconds).toBe(120.5);
  });

  it('returns agent resolution summaries for the selected range', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [
      { id: 'agent-1', external_id: 'AGENT-1', name: 'Maya', call_count: 5, resolved_count: 4,
        unresolved_count: 1, dropped_count: 0, escalated_count: 0, attention_count: 1,
        average_duration_seconds: '151.6' }
    ] });
    const repository = new DashboardRepository({ query } as unknown as pg.Pool);

    const result = await repository.getTeam(teamPeriod) as any;

    expect(result.totals).toEqual({ agents: 1, calls: 5, resolved: 4 });
    expect(result.agents[0]).toMatchObject({
      name: 'Maya', call_count: 5, resolved_count: 4,
      resolution_rate_percent: 80, average_duration_seconds: 152
    });
  });

  it('returns paginated calls with all seven agent etiquette rules unchanged', async () => {
    const rules = {
      greeted_customer: true, introduced_self: true, showed_empathy: null,
      showed_empathy_applicable: false, showed_empathy_reason: 'Routine banking request.', offered_help: true,
      provided_clear_guidance: true, thanked_customer: true, wished_customer_good_day: true
    };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'agent-1', external_id: 'AGENT-1', name: 'Maya' }] })
      .mockResolvedValueOnce({ rows: [{
        id: 'call-1', device_model: 'GENERAL', resolution_status: 'RESOLVED', duration_seconds: '90.5',
        rules, total_count: 1, total_resolved_count: 1
      }] });
    const repository = new DashboardRepository({ query } as unknown as pg.Pool);

    const result = await repository.getAgentCalls('AGENT-1', period, 1, 25) as any;

    expect(result.summary).toEqual({ call_count: 1, resolved_count: 1 });
    expect(result.items[0].rules).toEqual(rules);
    expect(Object.keys(result.items[0].rules)).toHaveLength(9);
    expect(result.items[0]).toMatchObject({ device_model: 'GENERAL', duration_seconds: 90.5 });
  });

  it('groups conversation quality by source agent ID and preserves logged name aliases', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: '44', external_id: '44', logged_names: ['Alex Morgan', 'Alexander Morgan'], call_count: 6
      }] })
      .mockResolvedValueOnce({ rows: [{
        rule: 'greeted_customer', agent_pass_percent: '75', agent_total_calls: 4,
        agent_fail_count: 1, team_pass_percent: '80'
      }] });
    const repository = new DashboardRepository({ query } as unknown as pg.Pool);

    const result = await repository.getAgentConversationQuality('44') as any;

    expect(result.agent).toMatchObject({
      id: '44', logged_names: ['Alex Morgan', 'Alexander Morgan'], call_count: 6
    });
    expect(result.rules[0]).toMatchObject({ rule: 'greeted_customer', agent_pass_percent: 75, total_calls: 4 });
    expect(String(query.mock.calls[0]![0])).toContain('source_agent_speaker_id');
    expect(String(query.mock.calls[1]![0])).toContain('source_agent_speaker_id');
  });
});
