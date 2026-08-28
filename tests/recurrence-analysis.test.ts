import { describe, expect, it } from 'vitest';
import { RecurrenceAnalysisContractError, validateRecurrenceReview,
  type RecurrenceReviewCall } from '../src/services/recurrence-analysis.js';

const calls: RecurrenceReviewCall[] = [
  {
    call_id: '11111111-1111-4111-8111-111111111111', external_call_id: 'CALL-1',
    started_at: new Date('2026-08-21T10:00:00Z'), title: 'Transfer pending', short_description: '',
    issue_category: 'MONEY_TRANSFER', issue_cause: 'TRANSACTION_PENDING', issue_summary: 'Bank transfer remains pending',
    resolution_status: 'DROPPED'
  },
  {
    call_id: '22222222-2222-4222-8222-222222222222', external_call_id: 'CALL-2',
    started_at: new Date('2026-08-23T10:00:00Z'), title: 'Transfer completed', short_description: '',
    issue_category: 'MONEY_TRANSFER', issue_cause: 'TRANSACTION_PENDING', issue_summary: 'Pending transfer completed',
    resolution_status: 'RESOLVED'
  },
  {
    call_id: '33333333-3333-4333-8333-333333333333', external_call_id: 'CALL-3',
    started_at: new Date('2026-08-22T10:00:00Z'), title: 'Cheque book', short_description: '',
    issue_category: 'CHEQUEBOOK_REQUEST', issue_cause: 'CUSTOMER_REQUEST', issue_summary: 'New cheque book requested',
    resolution_status: 'RESOLVED'
  }
];

function response(callIds = [calls[1]!.call_id, calls[0]!.call_id]) {
  return { groups: [{
    group_title: 'Repeated transfer issue', issue_category: 'MONEY_TRANSFER', issue_cause: 'TRANSACTION_PENDING',
    summary: 'The same pending transfer continued across two calls.',
    verdict: 'Recurring issue resolved during the second call.',
    recommended_action: 'Check the transfer status and all restrictions before closing.', call_ids: callIds
  }] };
}

describe('recurrence review validation', () => {
  it('accepts semantic groups and orders their calls chronologically', () => {
    const result = validateRecurrenceReview(response(), calls);
    expect(result[0]?.call_ids).toEqual([calls[0]!.call_id, calls[1]!.call_id]);
  });

  it('allows unrelated calls to remain ungrouped', () => {
    expect(validateRecurrenceReview({ groups: [] }, calls)).toEqual([]);
  });

  it('rejects unknown and overlapping call references', () => {
    expect(() => validateRecurrenceReview(response([
      calls[0]!.call_id, '44444444-4444-4444-8444-444444444444'
    ]), calls)).toThrowError(expect.objectContaining<Partial<RecurrenceAnalysisContractError>>({
      code: 'UNKNOWN_GROUP_CALL'
    }));
    const duplicated = response();
    duplicated.groups.push({ ...duplicated.groups[0]!, call_ids: [calls[0]!.call_id, calls[2]!.call_id] });
    expect(() => validateRecurrenceReview(duplicated, calls)).toThrowError(
      expect.objectContaining<Partial<RecurrenceAnalysisContractError>>({ code: 'OVERLAPPING_RECURRING_GROUPS' })
    );
  });
});
