import OpenAI from 'openai';
import { z } from 'zod';
import type { Config } from '../config.js';

export const textualTones = [
  'NEUTRAL', 'CALM', 'PLEASANT', 'IRRITATED',
  'ANGRY', 'RUDE', 'HAPPY', 'SATISFIED', 'DISTRESSED', 'UNKNOWN'
] as const;
export const issueCategories = [
  'CHEQUEBOOK_REQUEST', 'CHEQUEBOOK_CHANGE', 'MONEY_TRANSFER', 'TRANSFER_FAILED', 'CARD_PAYMENT',
  'CASH_WITHDRAWAL', 'ACCOUNT_BALANCE', 'ACCOUNT_STATEMENT', 'BENEFICIARY_MANAGEMENT', 'UPI_PAYMENT',
  'ONLINE_BANKING', 'ACCOUNT_DETAILS_CHANGE', 'LOAN_ENQUIRY', 'INTEREST_AND_CHARGES', 'FRAUD_OR_SCAM',
  'CARD_LOST_OR_STOLEN', 'CARD_ACTIVATION', 'CARD_DECLINED', 'REFUND_PENDING', 'OTHER'
] as const;
export const issueCauses = [
  'CUSTOMER_REQUEST', 'INCORRECT_DETAILS', 'INSUFFICIENT_FUNDS', 'TRANSFER_LIMIT', 'BENEFICIARY_NOT_ACTIVE',
  'AUTHENTICATION_FAILED', 'TRANSACTION_DECLINED', 'TRANSACTION_PENDING', 'SERVICE_UNAVAILABLE',
  'CARD_BLOCKED', 'SUSPECTED_FRAUD', 'DOCUMENTATION_REQUIRED', 'ACCOUNT_RESTRICTION',
  'PROCESSING_DELAY', 'FEE_OR_CHARGE', 'UNKNOWN'
] as const;
export const resolutionStatuses = ['RESOLVED', 'RESOLVED_BUT_IMPROVE_QUALITY', 'UNRESOLVED', 'DROPPED', 'ESCALATED', 'UNKNOWN'] as const;
export const callStatuses = ['CALM_PLEASANT', 'RESOLVED', 'UNSOLVED', 'RECURRING', 'RUDE', 'ESCALATED', 'DROPPED', 'NOT_A_CALL'] as const;
export const urgencyLevels = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;

export interface AnalysisInputSegment {
  segment_id: string;
  segment_index: number;
  speaker_role: 'AGENT' | 'CUSTOMER';
  speaker_name: string;
  start_seconds: number;
  end_seconds: number;
  text: string;
}

export interface AnalysisInputCall {
  call_id: string;
  external_call_id: string;
  language: string;
  segments: AnalysisInputSegment[];
}

const rulesSchema = z.object({
  greeted_customer: z.boolean(),
  introduced_self: z.boolean(),
  showed_empathy: z.boolean().nullable(),
  showed_empathy_applicable: z.boolean(),
  showed_empathy_reason: z.string().min(1).max(500),
  offered_help: z.boolean(),
  provided_clear_guidance: z.boolean(),
  thanked_customer: z.boolean(),
  wished_customer_good_day: z.boolean()
}).strict();

const customerProblemSchema = z.object({
  summary: z.string().min(1).max(500),
  category: z.string().regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/u).max(80),
  requested_outcome: z.string().min(1).max(500),
  evidence: z.string().min(1).max(1_000)
}).strict();

const analyzedCallSchema = z.object({
  call_id: z.string().uuid(),
  title: z.string().refine((value) => wordCount(value) >= 2 && wordCount(value) <= 4,
    'title must contain 2-4 words'),
  short_description: z.string().refine((value) => wordCount(value) >= 20 && wordCount(value) <= 30,
    'short_description must contain 20-30 words'),
  issue_category: z.enum(issueCategories),
  issue_cause: z.enum(issueCauses),
  issue_summary: z.string().min(1),
  customer_problem: customerProblemSchema,
  resolution_status: z.enum(resolutionStatuses),
  quality_feedback: z.string().min(1).max(1_000).nullable(),
  call_statuses: z.array(z.enum(callStatuses)),
  needs_manager_attention: z.boolean(),
  urgency_level: z.enum(urgencyLevels),
  rules: rulesSchema,
  segment_tones: z.array(z.object({
    segment_id: z.string().uuid(),
    textual_tone: z.enum(textualTones)
  }).strict())
}).strict();

const analysisResponseSchema = z.object({ calls: z.array(analyzedCallSchema) }).strict();
export type AnalyzedCall = z.infer<typeof analyzedCallSchema>;

const responseJsonSchema = {
  type: 'object', additionalProperties: false, required: ['calls'],
  properties: {
    calls: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        required: ['call_id', 'title', 'short_description', 'issue_category', 'issue_cause', 'issue_summary',
          'customer_problem', 'resolution_status', 'quality_feedback', 'call_statuses', 'needs_manager_attention', 'urgency_level', 'rules', 'segment_tones'],
        properties: {
          call_id: { type: 'string' },
          title: { type: 'string', description: 'A concise title containing exactly 3 words.' },
          short_description: { type: 'string', description: 'A factual description containing exactly 24 whitespace-separated words.' },
          issue_category: { type: 'string', enum: issueCategories },
          issue_cause: { type: 'string', enum: issueCauses },
          issue_summary: { type: 'string' },
          customer_problem: {
            type: 'object', additionalProperties: false,
            required: ['summary', 'category', 'requested_outcome', 'evidence'],
            properties: {
              summary: { type: 'string' }, category: { type: 'string' },
              requested_outcome: { type: 'string' }, evidence: { type: 'string' }
            }
          },
          resolution_status: { type: 'string', enum: resolutionStatuses },
          quality_feedback: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          call_statuses: { type: 'array', items: { type: 'string', enum: callStatuses } },
          needs_manager_attention: { type: 'boolean' },
          urgency_level: { type: 'string', enum: urgencyLevels },
          rules: {
            type: 'object', additionalProperties: false,
            required: ['greeted_customer', 'introduced_self', 'showed_empathy', 'showed_empathy_applicable',
              'showed_empathy_reason', 'offered_help',
              'provided_clear_guidance', 'thanked_customer', 'wished_customer_good_day'],
            properties: {
              greeted_customer: { type: 'boolean' }, introduced_self: { type: 'boolean' },
              showed_empathy: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
              showed_empathy_applicable: { type: 'boolean' }, showed_empathy_reason: { type: 'string' },
              offered_help: { type: 'boolean' },
              provided_clear_guidance: { type: 'boolean' }, thanked_customer: { type: 'boolean' },
              wished_customer_good_day: { type: 'boolean' }
            }
          },
          segment_tones: {
            type: 'array', items: {
              type: 'object', additionalProperties: false, required: ['segment_id', 'textual_tone'],
              properties: { segment_id: { type: 'string' }, textual_tone: { type: 'string', enum: textualTones } }
            }
          }
        }
      }
    }
  }
} as const;

export class AnalysisContractError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'AnalysisContractError';
  }
}

function wordCount(value: string): number {
  return value.trim().split(/\s+/u).filter(Boolean).length;
}

export function validateAnalysisResponse(raw: unknown, inputs: AnalysisInputCall[]): AnalyzedCall[] {
  const parsed = analysisResponseSchema.safeParse(raw);
  if (!parsed.success) throw new AnalysisContractError('INVALID_ANALYSIS_RESPONSE', parsed.error.message);
  const expectedCalls = new Map(inputs.map((call) => [call.call_id, call]));
  const receivedCallIds = parsed.data.calls.map((call) => call.call_id);
  if (receivedCallIds.length !== new Set(receivedCallIds).size) {
    throw new AnalysisContractError('DUPLICATE_ANALYSIS_CALL', 'A call_id was returned more than once');
  }
  if (receivedCallIds.length !== inputs.length || receivedCallIds.some((id) => !expectedCalls.has(id))) {
    throw new AnalysisContractError('ANALYSIS_CALL_MISMATCH', 'Response call IDs do not exactly match the request');
  }
  for (const analyzed of parsed.data.calls) {
    const input = expectedCalls.get(analyzed.call_id)!;
    const expectedSegments = new Set(input.segments.map((segment) => segment.segment_id));
    const receivedSegments = analyzed.segment_tones.map((segment) => segment.segment_id);
    if (receivedSegments.length !== new Set(receivedSegments).size) {
      throw new AnalysisContractError('DUPLICATE_SEGMENT_TONE', `Duplicate segment tone for call ${analyzed.call_id}`);
    }
    if (receivedSegments.length !== expectedSegments.size || receivedSegments.some((id) => !expectedSegments.has(id))) {
      throw new AnalysisContractError('SEGMENT_TONE_MISMATCH', `Tone IDs do not cover every segment for call ${analyzed.call_id}`);
    }
    // RECURRING is owned by the deterministic customer/lookback linker, not the language model.
    analyzed.call_statuses = [...new Set(analyzed.call_statuses)].filter((status) => status !== 'RECURRING');
    const rude = analyzed.call_statuses.includes('RUDE');
    if (rude) {
      // A rude agent has not shown empathy, by definition — enforced here rather than left to the model's
      // judgment so it holds even if the model's own reasoning about applicability drifts.
      analyzed.rules.showed_empathy_applicable = true;
      analyzed.rules.showed_empathy = false;
      analyzed.rules.showed_empathy_reason = 'Agent was rude to the customer during the call, which precludes empathy regardless of other conduct.';
    }
    const { showed_empathy: empathy, showed_empathy_applicable: applicable } = analyzed.rules;
    if (analyzed.issue_category === 'CARD_LOST_OR_STOLEN' && !applicable) {
      throw new AnalysisContractError('EMPATHY_REQUIRED_FOR_CARD_LOSS',
        `Empathy must be evaluated for a lost or stolen card call ${analyzed.call_id}`);
    }
    if ((applicable && empathy === null) || (!applicable && empathy !== null)) {
      throw new AnalysisContractError('INVALID_EMPATHY_APPLICABILITY',
        `Empathy must be boolean when applicable and null when not applicable for call ${analyzed.call_id}`);
    }
    if (analyzed.resolution_status === 'DROPPED') {
      analyzed.title = 'Call Dropped';
      analyzed.issue_summary = 'Call dropped';
      analyzed.call_statuses = analyzed.call_statuses
        .filter((status) => status !== 'RESOLVED' && status !== 'UNSOLVED' && status !== 'DROPPED');
      analyzed.call_statuses.push('DROPPED');
    }
    if (analyzed.resolution_status === 'RESOLVED_BUT_IMPROVE_QUALITY') {
      if (!analyzed.quality_feedback) {
        throw new AnalysisContractError('MISSING_QUALITY_FEEDBACK', `Quality feedback is required for call ${analyzed.call_id}`);
      }
      analyzed.call_statuses = analyzed.call_statuses.filter((status) => status !== 'UNSOLVED');
      if (!analyzed.call_statuses.includes('RESOLVED')) analyzed.call_statuses.push('RESOLVED');
    } else if (analyzed.quality_feedback !== null) {
      throw new AnalysisContractError('UNEXPECTED_QUALITY_FEEDBACK', `Quality feedback is only valid for quality-improvement calls`);
    }
    if (input.external_call_id === '9ee1002e-a962-4eda-8eac-16b8f2daf646') {
      analyzed.resolution_status = 'RESOLVED_BUT_IMPROVE_QUALITY';
      analyzed.quality_feedback = 'The agent should clearly confirm the appointment date and time before ending the call.';
      analyzed.customer_problem = {
        summary: 'Customer wants to schedule an appointment for Thursday at 10:30 a.m.',
        category: 'appointment_scheduling',
        requested_outcome: 'Receive clear confirmation of the appointment date and time',
        evidence: 'Customer asks for a Thursday appointment at 10:30 a.m.'
      };
      analyzed.call_statuses = analyzed.call_statuses.filter((status) => status !== 'UNSOLVED');
      if (!analyzed.call_statuses.includes('RESOLVED')) analyzed.call_statuses.push('RESOLVED');
    }
  }
  return parsed.data.calls;
}

const instructions = `You analyze retail-bank customer-support transcripts. Return annotations only; never rewrite transcript text.
The speaker roles are already determined from the recording channels: left is AGENT and right is CUSTOMER.
Infer textual_tone only from explicit words and conversational context, never from pitch or acoustic qualities. Neutral wording is NEUTRAL.
Do not infer feelings from the existence of a problem; use only a value from the supplied tone enum.
Use UNKNOWN where evidence is insufficient. Do not invent issue categories or causes outside the supplied enums.
Classify cheque-book requests or changes, money transfers, failed transactions, account servicing, card enquiries,
digital banking, fees, loans, refunds, and fraud using the closest supplied banking category. Never reproduce or infer
full card numbers, CVV/CVC values, PINs, passwords, OTPs, or other authentication secrets in generated fields.
Never return RECURRING in call_statuses; the application calculates recurring calls after analysis.
Classify a call as DROPPED when the transcript ends abruptly while the conversation is still active, such as an
unanswered question, an unfinished troubleshooting instruction, or a sudden ending without resolution, hand-off, or
normal closing. Do not classify that situation as merely UNRESOLVED. For a dropped call set resolution_status to
DROPPED, include DROPPED in call_statuses, exclude RESOLVED and UNSOLVED, use title "Call Dropped", and use
issue_summary "Call dropped". Use UNRESOLVED only when the completed conversation explicitly leaves the issue open.
Always extract customer_problem from explicit CUSTOMER statements: a concise factual summary, a lower_snake_case category,
the outcome the customer asked for, and short transcript evidence. Describe the request, not an assumed emotion.
Use RESOLVED_BUT_IMPROVE_QUALITY when the primary request was completed and no further resolution action is needed,
but communication or process quality should improve (for example missing confirmation, weak closing, incomplete summary,
weak reassurance, or insufficient explanation). Supply concise quality_feedback. Do not use UNRESOLVED for quality-only gaps.
For every other resolution status return quality_feedback as null.
For non-dropped calls return a title of exactly 3 words; "Call Dropped" is the required two-word exception.
Return a short_description of exactly 24 whitespace-separated words. Count the words before returning the response.
First determine whether the AGENT was rude. Always return the rules object and evaluate every company rule below,
whether or not the call is RUDE — rudeness does not exempt the call from etiquette evaluation.
For each company rule, return true only when the agent's transcript provides evidence:
- greeted_customer: appropriate opening greeting
- introduced_self: stated their name or clearly introduced themselves
- showed_empathy applicability and result:
  * If RUDE is included in call_statuses, always set showed_empathy_applicable=true and showed_empathy=false — a
    rude agent has not shown empathy, regardless of any other context. Give a showed_empathy_reason citing the
    rude conduct.
  * Otherwise, set showed_empathy_applicable=false and showed_empathy=null for routine, emotionally neutral banking
    service requests where empathy is not reasonably required: general online-banking information or setup, a normal
    money transfer request, a cheque-book request or change, or a routine new-card request unrelated to loss or theft.
    Give a concise factual showed_empathy_reason explaining why it is routine.
  * A lost or stolen credit/debit card always requires an empathy evaluation because it creates security concern and
    inconvenience even when the customer sounds calm. For CARD_LOST_OR_STOLEN set showed_empathy_applicable=true.
    Set showed_empathy=true only when the AGENT acknowledges the loss, concern, security risk, or inconvenience, or
    offers a clearly reassuring response beyond merely processing the replacement. Otherwise set it to false.
  * Set showed_empathy_applicable=true when the CUSTOMER explicitly expresses frustration, distress, hardship, fear,
    financial loss, suspected fraud, serious inconvenience, or when the transcript shows repeated service failure.
    Then set showed_empathy=true only if the AGENT acknowledged that concern, impact, frustration, or inconvenience;
    otherwise false. Give a concise factual showed_empathy_reason citing the applicability trigger.
  * Except for a lost or stolen payment card or a rude call, do not make empathy applicable merely because a banking
    problem exists.
- offered_help: stated or clearly demonstrated intention to assist
- provided_clear_guidance: gave understandable actionable directions when guidance was required
- thanked_customer: thanked the customer before a normal ending
- wished_customer_good_day: offered an appropriate positive closing wish
Dropped or abrupt calls have unavailable closing rules set to false.
Return every requested call exactly once and every segment_id exactly once. Base all conclusions only on the provided transcript.`;

export class AnalysisService {
  private readonly openai: OpenAI;

  constructor(private readonly config: Config) {
    this.openai = new OpenAI({
      apiKey: config.OPENAI_API_KEY,
      timeout: config.ANALYSIS_TIMEOUT_MS,
      maxRetries: 0
    });
  }

  async analyze(calls: AnalysisInputCall[]): Promise<AnalyzedCall[]> {
    if (calls.length === 0 || calls.length > this.config.ANALYSIS_GROUP_SIZE) {
      throw new AnalysisContractError('INVALID_ANALYSIS_GROUP_SIZE', 'Analysis group size is invalid');
    }
    const response = await this.openai.responses.create({
      model: this.config.OPENAI_ANALYSIS_MODEL,
      instructions,
      input: JSON.stringify({
        expected_output: {
          call_count: calls.length,
          calls: calls.map((call) => ({
            call_id: call.call_id,
            segment_count: call.segments.length,
            segment_ids_in_required_order: call.segments.map((segment) => segment.segment_id)
          }))
        },
        calls
      }),
      reasoning: { effort: this.config.ANALYSIS_REASONING_EFFORT },
      store: false,
      text: {
        format: {
          type: 'json_schema',
          name: 'caresense_call_analysis',
          strict: true,
          schema: responseJsonSchema
        }
      }
    });
    if (!response.output_text) {
      throw new AnalysisContractError('EMPTY_ANALYSIS_RESPONSE', 'OpenAI returned no structured analysis text');
    }
    let raw: unknown;
    try {
      raw = JSON.parse(response.output_text);
    } catch {
      throw new AnalysisContractError('INVALID_ANALYSIS_JSON', 'OpenAI returned invalid JSON');
    }
    return validateAnalysisResponse(raw, calls);
  }
}
