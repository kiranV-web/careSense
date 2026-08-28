import OpenAI from 'openai';
import { z } from 'zod';
import type { Config } from '../config.js';
import { issueCategories, issueCauses, resolutionStatuses } from './analysis.js';

export interface RecurrenceReviewCall {
  call_id: string;
  external_call_id: string;
  started_at: Date;
  title: string;
  short_description: string;
  issue_category: string;
  issue_cause: string;
  issue_summary: string;
  resolution_status: string;
}

const recurringGroupSchema = z.object({
  group_title: z.string().min(2).max(120),
  issue_category: z.enum(issueCategories),
  issue_cause: z.enum(issueCauses),
  summary: z.string().min(5).max(2_000),
  verdict: z.string().min(5).max(1_000),
  recommended_action: z.string().min(5).max(1_000),
  call_ids: z.array(z.string().uuid()).min(2)
}).strict();

const recurrenceResponseSchema = z.object({ groups: z.array(recurringGroupSchema) }).strict();
export type RecurrenceReviewGroup = z.infer<typeof recurringGroupSchema>;

const responseJsonSchema = {
  type: 'object', additionalProperties: false, required: ['groups'],
  properties: {
    groups: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        required: ['group_title', 'issue_category', 'issue_cause', 'summary', 'verdict',
          'recommended_action', 'call_ids'],
        properties: {
          group_title: { type: 'string' },
          issue_category: { type: 'string', enum: issueCategories },
          issue_cause: { type: 'string', enum: issueCauses },
          summary: { type: 'string' },
          verdict: { type: 'string' },
          recommended_action: { type: 'string' },
          call_ids: { type: 'array', minItems: 2, items: { type: 'string' } }
        }
      }
    }
  }
} as const;

export class RecurrenceAnalysisContractError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'RecurrenceAnalysisContractError';
  }
}

export function validateRecurrenceReview(raw: unknown, calls: RecurrenceReviewCall[]): RecurrenceReviewGroup[] {
  const parsed = recurrenceResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RecurrenceAnalysisContractError('INVALID_RECURRENCE_RESPONSE', parsed.error.message);
  }
  const byId = new Map(calls.map((call) => [call.call_id, call]));
  const assigned = new Set<string>();
  for (const group of parsed.data.groups) {
    if (new Set(group.call_ids).size !== group.call_ids.length) {
      throw new RecurrenceAnalysisContractError('DUPLICATE_GROUP_CALL', 'A recurring group contains a duplicate call');
    }
    for (const callId of group.call_ids) {
      if (!byId.has(callId)) {
        throw new RecurrenceAnalysisContractError('UNKNOWN_GROUP_CALL', `Unknown recurring call: ${callId}`);
      }
      if (assigned.has(callId)) {
        throw new RecurrenceAnalysisContractError('OVERLAPPING_RECURRING_GROUPS', `Call appears in two groups: ${callId}`);
      }
      assigned.add(callId);
    }
    group.call_ids.sort((left, right) =>
      byId.get(left)!.started_at.getTime() - byId.get(right)!.started_at.getTime());
  }
  return parsed.data.groups;
}

const instructions = `You review multiple retail-bank support call summaries belonging to one verified customer.
The calls are already restricted to the configured lookback period. Identify combinations that discuss the same
underlying customer problem, even when earlier per-call category or cause labels differ slightly. Customer identity
and temporal proximity alone are never sufficient: unrelated calls must remain ungrouped. Return only groups with at
least two calls. A call may belong to at most one group. Preserve chronological call order.

For every confirmed group, summarize the progression across calls and provide a clear verdict describing whether the
issue remained open, calls dropped, escalation occurred, or the latest call resolved it. recommended_action must tell
the agent what should be checked next; when relevant, explicitly advise checking all plausible causes before closing
the interaction. Base decisions only on supplied summaries and classifications. Return an empty groups array when no
calls describe the same underlying issue. Treat repeated contacts about the same cheque-book request, transfer,
transaction, card, account-service request, refund, fraud case, or banking case as candidates only when the summaries
show the same underlying matter. Never include payment credentials or authentication secrets in generated text.`;

export class RecurrenceAnalysisService {
  private readonly openai: OpenAI;

  constructor(private readonly config: Config) {
    this.openai = new OpenAI({
      apiKey: config.OPENAI_API_KEY,
      timeout: config.RECURRENCE_TIMEOUT_MS,
      maxRetries: 0
    });
  }

  async analyze(calls: RecurrenceReviewCall[]): Promise<RecurrenceReviewGroup[]> {
    if (calls.length < 2) return [];
    const response = await this.openai.responses.create({
      model: this.config.OPENAI_RECURRENCE_MODEL,
      instructions,
      input: JSON.stringify({
        calls: calls.map((call) => ({
          ...call,
          started_at: call.started_at.toISOString(),
          allowed_resolution_statuses: resolutionStatuses
        }))
      }),
      reasoning: { effort: this.config.ANALYSIS_REASONING_EFFORT },
      store: false,
      text: {
        format: {
          type: 'json_schema',
          name: 'caresense_recurrence_review',
          strict: true,
          schema: responseJsonSchema
        }
      }
    });
    if (!response.output_text) {
      throw new RecurrenceAnalysisContractError('EMPTY_RECURRENCE_RESPONSE', 'OpenAI returned no recurrence analysis');
    }
    let raw: unknown;
    try {
      raw = JSON.parse(response.output_text);
    } catch {
      throw new RecurrenceAnalysisContractError('INVALID_RECURRENCE_JSON', 'OpenAI returned invalid recurrence JSON');
    }
    return validateRecurrenceReview(raw, calls);
  }
}
