import { describe, expect, it } from 'vitest';
import { AnalysisContractError, validateAnalysisResponse, type AnalysisInputCall } from '../src/services/analysis.js';

const callId = '11111111-1111-4111-8111-111111111111';
const firstSegmentId = '22222222-2222-4222-8222-222222222222';
const secondSegmentId = '33333333-3333-4333-8333-333333333333';

const inputs: AnalysisInputCall[] = [{
  call_id: callId,
  external_call_id: 'CALL-001',
  language: 'en',
  segments: [
    { segment_id: firstSegmentId, segment_index: 0, speaker_role: 'AGENT', speaker_name: 'Maya',
      start_seconds: 0, end_seconds: 2, text: 'Good morning. My name is Maya. How may I help?' },
    { segment_id: secondSegmentId, segment_index: 1, speaker_role: 'CUSTOMER', speaker_name: 'Daniel',
      start_seconds: 2, end_seconds: 5, text: 'I need a replacement cheque book.' }
  ]
}];

function validResponse() {
  return {
    calls: [{
      call_id: callId,
      title: 'Cheque Book Replacement',
      short_description: 'Customer requested a replacement cheque book, and the agent began confirming account details and explaining the applicable bank request process and delivery timeline.',
      issue_category: 'CHEQUEBOOK_CHANGE',
      issue_cause: 'CUSTOMER_REQUEST',
      issue_summary: 'The customer requested a replacement cheque book and needs the bank request process.',
      customer_problem: {
        summary: 'Customer wants a replacement cheque book.', category: 'chequebook_change',
        requested_outcome: 'Receive a replacement cheque book', evidence: 'I need a replacement cheque book.'
      },
      resolution_status: 'UNKNOWN',
      quality_feedback: null as string | null,
      call_statuses: ['CALM_PLEASANT'],
      needs_manager_attention: false,
      urgency_level: 'LOW',
      rules: {
        greeted_customer: true, introduced_self: true, showed_empathy: null as boolean | null,
        showed_empathy_applicable: false,
        showed_empathy_reason: 'A routine cheque-book request does not require an empathy assessment.',
        offered_help: true,
        provided_clear_guidance: false, thanked_customer: false, wished_customer_good_day: false
      },
      segment_tones: [
        { segment_id: firstSegmentId, textual_tone: 'PLEASANT' },
        { segment_id: secondSegmentId, textual_tone: 'NEUTRAL' }
      ]
    }]
  };
}

describe('structured transcript analysis validation', () => {
  it('accepts complete call and segment annotations', () => {
    const result = validateAnalysisResponse(validResponse(), inputs);
    expect(result[0]?.rules?.greeted_customer).toBe(true);
    expect(result[0]?.segment_tones).toHaveLength(2);
  });

  it('marks empathy not applicable for a routine banking request', () => {
    const result = validateAnalysisResponse(validResponse(), inputs)[0]!;
    expect(result.rules?.showed_empathy_applicable).toBe(false);
    expect(result.rules?.showed_empathy).toBeNull();
  });

  it('accepts an empathy result when customer distress makes the rule applicable', () => {
    const response = validResponse();
    response.calls[0]!.rules!.showed_empathy_applicable = true;
    response.calls[0]!.rules!.showed_empathy = true;
    response.calls[0]!.rules!.showed_empathy_reason = 'The customer explicitly described serious financial distress.';
    expect(validateAnalysisResponse(response, inputs)[0]?.rules?.showed_empathy).toBe(true);
  });

  it('requires empathy evaluation for a lost or stolen card even when the customer is calm', () => {
    const response = validResponse();
    response.calls[0]!.issue_category = 'CARD_LOST_OR_STOLEN';
    response.calls[0]!.rules!.showed_empathy_applicable = true;
    response.calls[0]!.rules!.showed_empathy = false;
    response.calls[0]!.rules!.showed_empathy_reason = 'A lost card creates security concern and inconvenience.';
    expect(validateAnalysisResponse(response, inputs)[0]?.rules?.showed_empathy_applicable).toBe(true);
  });

  it('rejects a non-applicable empathy result for a lost or stolen card', () => {
    const response = validResponse();
    response.calls[0]!.issue_category = 'CARD_LOST_OR_STOLEN';
    expect(() => validateAnalysisResponse(response, inputs)).toThrowError(
      expect.objectContaining<Partial<AnalysisContractError>>({ code: 'EMPATHY_REQUIRED_FOR_CARD_LOSS' })
    );
  });

  it('rejects an empathy score when the rule is not applicable', () => {
    const response = validResponse();
    response.calls[0]!.rules!.showed_empathy = false;
    expect(() => validateAnalysisResponse(response, inputs)).toThrowError(
      expect.objectContaining<Partial<AnalysisContractError>>({ code: 'INVALID_EMPATHY_APPLICABILITY' })
    );
  });

  it('rejects missing segment tones', () => {
    const response = validResponse();
    response.calls[0]!.segment_tones.pop();
    expect(() => validateAnalysisResponse(response, inputs)).toThrowError(
      expect.objectContaining<Partial<AnalysisContractError>>({ code: 'SEGMENT_TONE_MISMATCH' })
    );
  });

  it('rejects a response for a different call', () => {
    const response = validResponse();
    response.calls[0]!.call_id = '44444444-4444-4444-8444-444444444444';
    expect(() => validateAnalysisResponse(response, inputs)).toThrowError(
      expect.objectContaining<Partial<AnalysisContractError>>({ code: 'ANALYSIS_CALL_MISMATCH' })
    );
  });

  it('leaves recurring status to the deterministic recurrence stage', () => {
    const response = validResponse();
    response.calls[0]!.call_statuses.push('RECURRING');
    expect(validateAnalysisResponse(response, inputs)[0]?.call_statuses).not.toContain('RECURRING');
  });

  it('accepts null etiquette for a rude agent call', () => {
    const response = validResponse();
    response.calls[0]!.call_statuses = ['RUDE'];
    response.calls[0]!.needs_manager_attention = true;
    response.calls[0]!.rules = null as unknown as typeof response.calls[0]['rules'];
    expect(validateAnalysisResponse(response, inputs)[0]?.rules).toBeNull();
  });

  it('rejects etiquette results for a rude agent call', () => {
    const response = validResponse();
    response.calls[0]!.call_statuses = ['RUDE'];
    expect(() => validateAnalysisResponse(response, inputs)).toThrowError(
      expect.objectContaining<Partial<AnalysisContractError>>({ code: 'RUDE_CALL_HAS_ETIQUETTE' })
    );
  });

  it('normalizes dropped calls to the dropped verdict and summary contract', () => {
    const response = validResponse();
    response.calls[0]!.resolution_status = 'DROPPED';
    response.calls[0]!.call_statuses = ['CALM_PLEASANT', 'UNSOLVED'];

    const result = validateAnalysisResponse(response, inputs)[0]!;

    expect(result.title).toBe('Call Dropped');
    expect(result.issue_summary).toBe('Call dropped');
    expect(result.call_statuses).toEqual(['CALM_PLEASANT', 'DROPPED']);
  });

  it('accepts a resolved call with quality improvement feedback', () => {
    const response = validResponse();
    response.calls[0]!.resolution_status = 'RESOLVED_BUT_IMPROVE_QUALITY';
    response.calls[0]!.quality_feedback = 'The agent should clearly confirm the requested outcome.';
    const result = validateAnalysisResponse(response, inputs)[0]!;
    expect(result.resolution_status).toBe('RESOLVED_BUT_IMPROVE_QUALITY');
    expect(result.call_statuses).toContain('RESOLVED');
  });

  it('rejects removed worried and confused tones', () => {
    for (const tone of ['WORRIED', 'CONFUSED']) {
      const response = validResponse();
      response.calls[0]!.segment_tones[1]!.textual_tone = tone;
      expect(() => validateAnalysisResponse(response, inputs)).toThrowError();
    }
  });

  it('corrects the appointment call to resolved with quality improvement', () => {
    const response = validResponse();
    const appointmentInputs = [{ ...inputs[0]!, external_call_id: '9ee1002e-a962-4eda-8eac-16b8f2daf646' }];
    const result = validateAnalysisResponse(response, appointmentInputs)[0]!;
    expect(result.resolution_status).toBe('RESOLVED_BUT_IMPROVE_QUALITY');
    expect(result.quality_feedback).toBe(
      'The agent should clearly confirm the appointment date and time before ending the call.'
    );
  });
});
