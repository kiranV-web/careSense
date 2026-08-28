export interface RecurrenceCandidate {
  id: string;
  issue_category: string;
  issue_cause: string;
  resolution_status: string;
  started_at: Date;
}

export interface RecurringSet {
  issueCategory: string;
  issueCause: string;
  calls: RecurrenceCandidate[];
}

export function findRecurringSets(candidates: RecurrenceCandidate[]): RecurringSet[] {
  const grouped = new Map<string, RecurrenceCandidate[]>();
  for (const candidate of candidates) {
    if (!candidate.issue_category || !candidate.issue_cause || candidate.issue_cause === 'UNKNOWN') continue;
    const key = `${candidate.issue_category}\u0000${candidate.issue_cause}`;
    const group = grouped.get(key) ?? [];
    group.push(candidate);
    grouped.set(key, group);
  }
  const recurring: RecurringSet[] = [];
  for (const calls of grouped.values()) {
    calls.sort((left, right) => left.started_at.getTime() - right.started_at.getTime());
    if (calls.length < 2) continue;
    const earlierCallWasUnresolved = calls.slice(0, -1).some((call) =>
      call.resolution_status === 'UNRESOLVED' || call.resolution_status === 'DROPPED');
    if (!earlierCallWasUnresolved) continue;
    recurring.push({ issueCategory: calls[0]!.issue_category, issueCause: calls[0]!.issue_cause, calls });
  }
  return recurring;
}
