import { describe, expect, it } from 'vitest';
import {
  attentionUrgencyLabel, calculateManagerAttention, isActiveAttentionCall, rankAttentionCalls,
  type ManagerAttentionInput
} from '../src/services/managerAttention.js';

function call(overrides: Partial<ManagerAttentionInput> & { id: string }): ManagerAttentionInput {
  return { started_at: '2026-01-01T00:00:00Z', call_statuses: [], resolution_status: 'RESOLVED', ...overrides };
}

describe('attentionUrgencyLabel', () => {
  it('maps score bands to labels', () => {
    expect(attentionUrgencyLabel(96)).toBe('Critical');
    expect(attentionUrgencyLabel(90)).toBe('Critical');
    expect(attentionUrgencyLabel(89)).toBe('High');
    expect(attentionUrgencyLabel(75)).toBe('High');
    expect(attentionUrgencyLabel(74)).toBe('Medium');
    expect(attentionUrgencyLabel(60)).toBe('Medium');
    expect(attentionUrgencyLabel(59)).toBe('Elevated review');
    expect(attentionUrgencyLabel(45)).toBe('Elevated review');
    expect(attentionUrgencyLabel(44)).toBe('Quality review');
    expect(attentionUrgencyLabel(0)).toBe('Quality review');
  });
});

describe('isActiveAttentionCall', () => {
  it('is false for a routine resolved call with no flags', () => {
    expect(isActiveAttentionCall(call({ id: 'a' }))).toBe(false);
  });

  it('is true for RUDE, RECURRING, UNRESOLVED, ESCALATED, and quality-review calls', () => {
    expect(isActiveAttentionCall(call({ id: 'a', call_statuses: ['RUDE'] }))).toBe(true);
    expect(isActiveAttentionCall(call({ id: 'a', call_statuses: ['RECURRING'] }))).toBe(true);
    expect(isActiveAttentionCall(call({ id: 'a', resolution_status: 'UNRESOLVED' }))).toBe(true);
    expect(isActiveAttentionCall(call({ id: 'a', resolution_status: 'ESCALATED' }))).toBe(true);
    expect(isActiveAttentionCall(call({ id: 'a', resolution_status: 'RESOLVED_BUT_IMPROVE_QUALITY' }))).toBe(true);
    expect(isActiveAttentionCall(call({ id: 'a', needs_manager_attention: true }))).toBe(true);
  });

  it('is false once the manager alert is closed or the call was dropped, regardless of other flags', () => {
    expect(isActiveAttentionCall(call({ id: 'a', call_statuses: ['RUDE'], manager_alert_status: 'CLOSED' }))).toBe(false);
    expect(isActiveAttentionCall(call({ id: 'a', call_statuses: ['RUDE'], resolution_status: 'DROPPED' }))).toBe(false);
  });
});

describe('calculateManagerAttention', () => {
  it('returns null for a call that does not need attention', () => {
    expect(calculateManagerAttention(call({ id: 'a' }))).toBeNull();
  });

  it('scores a rude call at the 90 base with no additions when nothing else applies', () => {
    const now = new Date('2026-01-01T01:00:00Z');
    const result = calculateManagerAttention(call({ id: 'a', call_statuses: ['RUDE'] }), now);
    expect(result?.score).toBe(90);
    expect(result?.urgency_label).toBe('Critical');
    expect(result?.primary_reason).toBe('Rude call');
    expect(result?.factors[0]).toEqual({ label: 'Base priority: Rude call', value: 90, kind: 'BASE' });
  });

  it('prioritizes recurring+unresolved over recurring alone', () => {
    const now = new Date('2026-01-01T01:00:00Z');
    const result = calculateManagerAttention(call({ id: 'a', call_statuses: ['RECURRING'], resolution_status: 'UNRESOLVED' }), now);
    expect(result?.primary_reason).toBe('Recurring unresolved');
    expect(result?.score).toBe(82);
  });

  it('adds SLA-overdue points once a call has been open 12+ hours', () => {
    const now = new Date('2026-01-01T13:00:00Z');
    const result = calculateManagerAttention(call({ id: 'a', resolution_status: 'UNRESOLVED', started_at: '2026-01-01T00:00:00Z' }), now);
    expect(result?.waiting_hours).toBe(13);
    expect(result?.additional_reasons).toContain('SLA overdue');
    expect(result?.score).toBe(75 + 5 + 2);
  });

  it('does not add SLA-overdue points before 12 hours have elapsed', () => {
    const now = new Date('2026-01-01T05:00:00Z');
    const result = calculateManagerAttention(call({ id: 'a', resolution_status: 'UNRESOLVED', started_at: '2026-01-01T00:00:00Z' }), now);
    expect(result?.additional_reasons).not.toContain('SLA overdue');
    expect(result?.score).toBe(75);
  });

  it('prefers manager_alert_created_at over started_at for the waiting clock', () => {
    const now = new Date('2026-01-02T00:00:00Z');
    const result = calculateManagerAttention(call({
      id: 'a', resolution_status: 'UNRESOLVED', started_at: '2026-01-01T00:00:00Z',
      manager_alert_created_at: '2026-01-01T23:00:00Z'
    }), now);
    expect(result?.waiting_hours).toBe(1);
  });

  it('caps the final score at 100', () => {
    const now = new Date('2026-01-02T00:00:00Z');
    const result = calculateManagerAttention(call({
      id: 'a', call_statuses: ['RUDE', 'RECURRING'], resolution_status: 'UNRESOLVED', started_at: '2026-01-01T00:00:00Z'
    }), now);
    expect(result?.score).toBe(100);
  });
});

describe('rankAttentionCalls', () => {
  it('sorts by score descending, filters out inactive calls, and assigns rank/neighbour links', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const calls = [
      call({ id: 'quiet', resolution_status: 'RESOLVED' }),
      call({ id: 'unresolved', resolution_status: 'UNRESOLVED', started_at: '2026-01-01T00:00:00Z' }),
      call({ id: 'rude', call_statuses: ['RUDE'], started_at: '2026-01-01T00:00:00Z' }),
    ];
    const ranked = rankAttentionCalls(calls, now);
    expect(ranked.map((entry) => entry.id)).toEqual(['rude', 'unresolved']);
    expect(ranked[0]!.manager_attention.rank).toBe(1);
    expect(ranked[0]!.manager_attention.total_attention_calls).toBe(2);
    expect(ranked[0]!.manager_attention.previous_call_id).toBeNull();
    expect(ranked[0]!.manager_attention.next_call_id).toBe('unresolved');
    expect(ranked[1]!.manager_attention.rank).toBe(2);
    expect(ranked[1]!.manager_attention.previous_call_id).toBe('rude');
    expect(ranked[1]!.manager_attention.next_call_id).toBeNull();
  });
});
