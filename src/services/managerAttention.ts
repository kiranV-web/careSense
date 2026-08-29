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
  /** Count of failed call-etiquette rules (out of the 7 evaluated; showed_empathy only
   * counts when applicable) — drives the "Etiquette missed" scoring factor below. */
  missed_etiquette_count?: number | null;
}

export interface ManagerAttentionResult {
  score: number;
  /** The uncapped sum of every applicable factor — equal to `score` unless the sum
   * exceeded the 99 cap, in which case this shows what it rounded down from. */
  raw_score: number;
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

// Point values for each independent scoring factor. Every applicable factor is summed;
// the total is then capped so the score never reaches 100.
const MAX_SCORE = 99;
const RUDE_CALL_POINTS = 50;
const RECURRING_CALL_POINTS = 15;
const UNRESOLVED_POINTS = 30;
const ETIQUETTE_BASE_POINTS = 30;
const ETIQUETTE_PER_RULE_POINTS = 5;

export function calculateManagerAttention(call: ManagerAttentionInput, now = new Date()): ManagerAttentionResult | null {
  if (!isActiveAttentionCall(call)) return null;
  const statuses = call.call_statuses ?? [];
  const rude = statuses.includes('RUDE');
  const recurring = statuses.includes('RECURRING');
  const unresolved = call.resolution_status === 'UNRESOLVED' || call.resolution_status === 'ESCALATED';
  const missedEtiquetteCount = call.missed_etiquette_count ?? 0;

  const factors: AttentionScoreFactor[] = [];
  if (rude) factors.push({ label: 'Rude call', value: RUDE_CALL_POINTS, kind: 'ADDITION' });
  if (unresolved) factors.push({ label: 'Unresolved', value: UNRESOLVED_POINTS, kind: 'ADDITION' });
  if (missedEtiquetteCount > 0) {
    factors.push({
      label: `Etiquette missed (${missedEtiquetteCount} rule${missedEtiquetteCount === 1 ? '' : 's'})`,
      value: ETIQUETTE_BASE_POINTS + ETIQUETTE_PER_RULE_POINTS * missedEtiquetteCount,
      kind: 'ADDITION'
    });
  }
  if (recurring) factors.push({ label: 'Recurring call', value: RECURRING_CALL_POINTS, kind: 'ADDITION' });

  const rawScore = factors.reduce((sum, factor) => sum + factor.value, 0);
  const score = Math.min(MAX_SCORE, rawScore);

  // The highest-value factor is the headline reason; every other applicable factor
  // is listed as an additional reason.
  const primary = factors.reduce(
    (best, factor) => (factor.value > best.value ? factor : best),
    factors[0] ?? { label: 'Manager review requested', value: 0, kind: 'ADDITION' as const }
  );
  const additionalReasons = factors.filter((factor) => factor !== primary).map((factor) => factor.label);

  const openedAt = new Date(call.manager_alert_created_at ?? call.started_at);
  const waitingHours = Math.max(0, Math.floor((now.getTime() - openedAt.getTime()) / 3_600_000));

  return {
    score,
    raw_score: rawScore,
    urgency_label: attentionUrgencyLabel(score),
    primary_reason: primary.label,
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
