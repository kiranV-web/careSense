export interface AttentionScoreFactor {
  label: string;
  value: number;
  kind: 'BASE' | 'ADDITION';
}

export interface ManagerAttentionInput {
  id: string;
  call_statuses?: string[] | null;
  resolution_status?: string | null;
  needs_manager_attention?: boolean | null;
  started_at: string | Date;
  manager_alert_created_at?: string | Date | null;
  manager_alert_status?: string | null;
}

export interface ManagerAttentionResult {
  score: number;
  urgency_label: string;
  primary_reason: string;
  additional_reasons: string[];
  factors: AttentionScoreFactor[];
  calculated_at: string;
  waiting_hours: number;
  rank?: number;
  total_attention_calls?: number;
  previous_call_id?: string | null;
  next_call_id?: string | null;
}

export function attentionUrgencyLabel(score: number): string {
  if (score >= 90) return 'Critical';
  if (score >= 75) return 'High';
  if (score >= 60) return 'Medium';
  if (score >= 45) return 'Elevated review';
  return 'Quality review';
}

export function isActiveAttentionCall(call: ManagerAttentionInput): boolean {
  if (call.manager_alert_status === 'CLOSED' || call.resolution_status === 'DROPPED') return false;
  const statuses = call.call_statuses ?? [];
  return Boolean(call.needs_manager_attention) || statuses.includes('RUDE') || statuses.includes('RECURRING')
    || call.resolution_status === 'UNRESOLVED' || call.resolution_status === 'ESCALATED'
    || call.resolution_status === 'RESOLVED_BUT_IMPROVE_QUALITY';
}

export function calculateManagerAttention(call: ManagerAttentionInput, now = new Date()): ManagerAttentionResult | null {
  if (!isActiveAttentionCall(call)) return null;
  const statuses = call.call_statuses ?? [];
  const rude = statuses.includes('RUDE');
  const recurring = statuses.includes('RECURRING');
  const unresolved = call.resolution_status === 'UNRESOLVED';
  const escalated = call.resolution_status === 'ESCALATED';
  const qualityReview = call.resolution_status === 'RESOLVED_BUT_IMPROVE_QUALITY';

  let primaryReason: string;
  let base: number;
  if (rude) [primaryReason, base] = ['Rude call', 90];
  else if (recurring && unresolved) [primaryReason, base] = ['Recurring unresolved', 82];
  else if (escalated) [primaryReason, base] = ['Escalated call', 85];
  else if (unresolved) [primaryReason, base] = ['Unresolved', 75];
  else if (recurring) [primaryReason, base] = ['Recurring issue', 65];
  else if (qualityReview) [primaryReason, base] = ['Quality review', 35];
  else [primaryReason, base] = ['Manager review requested', 45];

  const factors: AttentionScoreFactor[] = [{ label: `Base priority: ${primaryReason}`, value: base, kind: 'BASE' }];
  const additionalReasons: string[] = [];
  let score = base;
  const add = (label: string, value: number, reason?: string): void => {
    factors.push({ label, value, kind: 'ADDITION' });
    score += value;
    if (reason && reason !== primaryReason && !additionalReasons.includes(reason)) additionalReasons.push(reason);
  };
  if (recurring && primaryReason !== 'Recurring unresolved' && primaryReason !== 'Recurring issue') add('Recurring issue', 3, 'Recurring');
  if (unresolved && primaryReason !== 'Recurring unresolved' && primaryReason !== 'Unresolved') add('Issue remains unresolved', 5, 'Unresolved');
  if (qualityReview && primaryReason !== 'Quality review') add('Communication quality review', 2, 'Quality review');
  if (escalated && primaryReason !== 'Escalated call') add('Escalated', 5, 'Escalated');

  const openedAt = new Date(call.manager_alert_created_at ?? call.started_at);
  const waitingHours = Math.max(0, Math.floor((now.getTime() - openedAt.getTime()) / 3_600_000));
  if (waitingHours >= 12) {
    add('SLA overdue', 5, 'SLA overdue');
    add('Open for more than 12 hours', 2);
  }
  score = Math.min(100, score);
  return {
    score,
    urgency_label: attentionUrgencyLabel(score),
    primary_reason: primaryReason,
    additional_reasons: additionalReasons,
    factors,
    calculated_at: now.toISOString(),
    waiting_hours: waitingHours
  };
}

export function rankAttentionCalls<T extends ManagerAttentionInput>(calls: T[], now = new Date()): Array<T & { manager_attention: ManagerAttentionResult }> {
  const scored = calls.flatMap((call) => {
    const managerAttention = calculateManagerAttention(call, now);
    return managerAttention ? [{ ...call, manager_attention: managerAttention }] : [];
  }).sort((left, right) => right.manager_attention.score - left.manager_attention.score
    || new Date(left.started_at).getTime() - new Date(right.started_at).getTime()
    || left.id.localeCompare(right.id));
  return scored.map((call, index, all) => ({
    ...call,
    manager_attention: {
      ...call.manager_attention,
      rank: index + 1,
      total_attention_calls: all.length,
      previous_call_id: all[index - 1]?.id ?? null,
      next_call_id: all[index + 1]?.id ?? null
    }
  }));
}
