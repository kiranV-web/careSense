import { describe, expect, it } from 'vitest';
import { findRecurringSets, type RecurrenceCandidate } from '../src/services/recurrence.js';

function call(id: string, day: number, resolution: string, cause = 'TRANSACTION_PENDING'): RecurrenceCandidate {
  return {
    id, issue_category: 'MONEY_TRANSFER', issue_cause: cause, resolution_status: resolution,
    started_at: new Date(`2026-08-${String(day).padStart(2, '0')}T09:00:00Z`)
  };
}

describe('recurring unresolved call detection', () => {
  it('links the same known issue when an earlier call was unresolved', () => {
    const sets = findRecurringSets([call('first', 20, 'UNRESOLVED'), call('second', 22, 'RESOLVED')]);
    expect(sets).toHaveLength(1);
    expect(sets[0]?.calls.map((item) => item.id)).toEqual(['first', 'second']);
  });

  it('does not link calls when only the latest call is unresolved', () => {
    expect(findRecurringSets([call('first', 20, 'RESOLVED'), call('second', 22, 'UNRESOLVED')])).toEqual([]);
  });

  it('does not link UNKNOWN causes or different causes', () => {
    expect(findRecurringSets([call('first', 20, 'UNRESOLVED', 'UNKNOWN'), call('second', 22, 'RESOLVED', 'UNKNOWN')])).toEqual([]);
    expect(findRecurringSets([call('first', 20, 'UNRESOLVED'), call('second', 22, 'RESOLVED', 'TRANSFER_LIMIT')])).toEqual([]);
  });
});
