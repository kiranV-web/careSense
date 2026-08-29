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

  it('scores a rude call at 50 with no other factors', () => {
    const result = calculateManagerAttention(call({ id: 'a', call_statuses: ['RUDE'] }));
    expect(result?.score).toBe(50);
    expect(result?.urgency_label).toBe('Elevated review');
    expect(result?.primary_reason).toBe('Rude call');
    expect(result?.factors).toEqual([{ label: 'Rude call', value: 50, kind: 'ADDITION' }]);
    expect(result?.additional_reasons).toEqual([]);
  });

  it('scores a recurring call at 15', () => {
    const result = calculateManagerAttention(call({ id: 'a', call_statuses: ['RECURRING'] }));
    expect(result?.score).toBe(15);
    expect(result?.primary_reason).toBe('Recurring call');
  });

  it('scores an unresolved call at 30, and treats escalated the same as unresolved', () => {
    const unresolved = calculateManagerAttention(call({ id: 'a', resolution_status: 'UNRESOLVED' }));
    expect(unresolved?.score).toBe(30);
    expect(unresolved?.primary_reason).toBe('Unresolved');

    const escalated = calculateManagerAttention(call({ id: 'a', resolution_status: 'ESCALATED' }));
    expect(escalated?.score).toBe(30);
    expect(escalated?.primary_reason).toBe('Unresolved');
  });

  it('scores missed etiquette rules as 30 base + 5 per rule', () => {
    const result = calculateManagerAttention(call({
      id: 'a', resolution_status: 'RESOLVED_BUT_IMPROVE_QUALITY', missed_etiquette_count: 3
    }));
    expect(result?.score).toBe(30 + 5 * 3);
    expect(result?.primary_reason).toBe('Etiquette missed (3 rules)');
    expect(result?.factors).toEqual([{ label: 'Etiquette missed (3 rules)', value: 45, kind: 'ADDITION' }]);
  });

  it('uses singular wording for exactly one missed rule', () => {
    const result = calculateManagerAttention(call({
      id: 'a', resolution_status: 'RESOLVED_BUT_IMPROVE_QUALITY', missed_etiquette_count: 1
    }));
    expect(result?.primary_reason).toBe('Etiquette missed (1 rule)');
    expect(result?.score).toBe(35);
  });

  it('sums every applicable factor and picks the highest as the primary reason', () => {
    const result = calculateManagerAttention(call({
      id: 'a', call_statuses: ['RUDE', 'RECURRING'], resolution_status: 'UNRESOLVED', missed_etiquette_count: 2
    }));
    // 50 (rude) + 30 (unresolved) + 40 (30 + 5*2 etiquette) + 15 (recurring) = 135, capped at 99
    expect(result?.score).toBe(99);
    expect(result?.primary_reason).toBe('Rude call');
    expect(result?.additional_reasons).toEqual(
      expect.arrayContaining(['Unresolved', 'Etiquette missed (2 rules)', 'Recurring call'])
    );
    expect(result?.additional_reasons).toHaveLength(3);
  });

  it('never returns a score of 100 or above', () => {
    const result = calculateManagerAttention(call({
      id: 'a', call_statuses: ['RUDE', 'RECURRING'], resolution_status: 'UNRESOLVED', missed_etiquette_count: 7
    }));
    expect(result?.score).toBeLessThanOrEqual(99);
  });

  it('still computes waiting_hours from manager_alert_created_at for display, without affecting the score', () => {
    const now = new Date('2026-01-02T00:00:00Z');
    const result = calculateManagerAttention(call({
      id: 'a', call_statuses: ['RUDE'], started_at: '2026-01-01T00:00:00Z',
      manager_alert_created_at: '2026-01-01T23:00:00Z'
    }), now);
    expect(result?.waiting_hours).toBe(1);
    expect(result?.score).toBe(50);
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
