import { resolutionStatuses, issueCategories } from './analysis.js';
import { ChatRepository, type EtiquetteRule } from '../db/chat.repository.js';

const ETIQUETTE_RULE_ENUM: EtiquetteRule[] = [
  'greeted_customer', 'introduced_self', 'showed_empathy', 'offered_help',
  'provided_clear_guidance', 'thanked_customer', 'wished_customer_good_day'
];

const optionalDateParam = {
  type: ['string', 'null'], format: 'date-time',
  description: 'ISO 8601 timestamp, or null to leave unbounded. Omit both date params entirely (pass null) unless the user names a specific period — every function defaults to full history.'
} as const;

const READONLY_QUERY_SCHEMA_DOC = `
Tables available (all read-only):
- call_recordings(id, external_call_id, agent_id, customer_id, batch_id, started_at, language, device_model,
  banking_product, title, short_description, issue_category, issue_cause, issue_summary, resolution_status
  ['RESOLVED','RESOLVED_BUT_IMPROVE_QUALITY','UNRESOLVED','DROPPED','ESCALATED','UNKNOWN'], quality_feedback,
  call_statuses text[] (may contain 'RUDE','ESCALATED','RECURRING','DROPPED', etc.), needs_manager_attention bool,
  urgency_level ['LOW','MEDIUM','HIGH','CRITICAL'])
- agents(id, external_id, name)
- customers(id, external_id, name)
- call_evaluations(call_recording_id, greeted_customer, introduced_self, showed_empathy, offered_help,
  provided_clear_guidance, thanked_customer, wished_customer_good_day) -- all boolean
- transcripts(call_recording_id, duration_seconds, full_text)
- transcript_segments(call_recording_id, speaker_role ['AGENT','CUSTOMER'], textual_tone, text, start_seconds)
- recurring_call_groups(customer_id, issue_category, issue_cause, group_title, summary, verdict,
  recommended_action, outcome_status, first_call_at, latest_call_at)
- manager_alerts(call_recording_id, status ['OPEN','IN_REVIEW','CLOSED'], urgency_level, manager_notes)
Do not reference any other table or column (e.g. never select storage/file internals like object_key,
storage_bucket, audio_checksum, raw_metadata, recording_url).`;

export const CHAT_TOOLS = [
  {
    type: 'function' as const,
    name: 'get_call_volume',
    description: 'Count calls grouped by day, week, or month, optionally within a date range. Use for "how many calls" questions.',
    strict: true,
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['date_from', 'date_to', 'group_by'],
      properties: { date_from: optionalDateParam, date_to: optionalDateParam, group_by: { type: 'string', enum: ['day', 'week', 'month'] } }
    }
  },
  {
    type: 'function' as const,
    name: 'rank_agents_by_quality',
    description: 'Rank agents by etiquette-rule quality score and resolution rate, optionally within a date range. Use for "best/worst agent" questions.',
    strict: true,
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['date_from', 'date_to', 'order', 'min_call_count', 'limit'],
      properties: {
        date_from: optionalDateParam, date_to: optionalDateParam,
        order: { type: 'string', enum: ['best', 'worst'] },
        min_call_count: { type: 'integer', minimum: 1, description: 'Exclude agents with fewer calls than this, to avoid misleading small-sample rankings.' },
        limit: { type: 'integer', minimum: 1, maximum: 50 }
      }
    }
  },
  {
    type: 'function' as const,
    name: 'compare_agents',
    description: 'Get side-by-side quality metrics for a specific set of agents, matched by name (fuzzy) or external ID, optionally within a date range.',
    strict: true,
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['agent_names', 'date_from', 'date_to'],
      properties: {
        agent_names: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50 },
        date_from: optionalDateParam, date_to: optionalDateParam
      }
    }
  },
  {
    type: 'function' as const,
    name: 'list_agents',
    description: 'List all agents with their total call counts. Use to discover agent names when the user names someone ambiguously, or to answer "who are our agents" questions.',
    strict: true,
    parameters: {
      type: 'object', additionalProperties: false, required: ['limit'],
      properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } }
    }
  },
  {
    type: 'function' as const,
    name: 'get_agent_etiquette_breakdown',
    description: 'Get one specific agent’s etiquette-rule pass/fail rates, optionally within a date range. Use for "what should THIS agent improve" questions, as opposed to team-wide questions.',
    strict: true,
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['agent_name', 'date_from', 'date_to'],
      properties: { agent_name: { type: 'string' }, date_from: optionalDateParam, date_to: optionalDateParam }
    }
  },
  {
    type: 'function' as const,
    name: 'get_team_etiquette_failure_rates',
    description: 'Get the fail rate of each of the 7 call-etiquette rules across the whole team, optionally within a date range. Use for "what does everyone miss / what should the team improve" questions.',
    strict: true,
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['date_from', 'date_to'],
      properties: { date_from: optionalDateParam, date_to: optionalDateParam }
    }
  },
  {
    type: 'function' as const,
    name: 'get_issue_category_breakdown',
    description: 'Count calls by issue category, optionally within a date range, most common first. Use for "what are customers complaining about" questions.',
    strict: true,
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['date_from', 'date_to', 'limit'],
      properties: { date_from: optionalDateParam, date_to: optionalDateParam, limit: { type: 'integer', minimum: 1, maximum: 50 } }
    }
  },
  {
    type: 'function' as const,
    name: 'get_resolution_breakdown',
    description: 'Count and percentage of calls by resolution status (resolved, unresolved, escalated, dropped, etc.), optionally within a date range. Use for "what % of calls get resolved" questions.',
    strict: true,
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['date_from', 'date_to'],
      properties: { date_from: optionalDateParam, date_to: optionalDateParam }
    }
  },
  {
    type: 'function' as const,
    name: 'get_banking_product_breakdown',
    description: 'Count calls by banking product (e.g. credit cards, loans), optionally within a date range, most common first.',
    strict: true,
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['date_from', 'date_to', 'limit'],
      properties: { date_from: optionalDateParam, date_to: optionalDateParam, limit: { type: 'integer', minimum: 1, maximum: 50 } }
    }
  },
  {
    type: 'function' as const,
    name: 'get_device_model_breakdown',
    description: 'Count calls by customer device model, optionally within a date range, most common first. Use for "what devices are customers calling from" or device-correlated-issue questions.',
    strict: true,
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['date_from', 'date_to', 'limit'],
      properties: { date_from: optionalDateParam, date_to: optionalDateParam, limit: { type: 'integer', minimum: 1, maximum: 50 } }
    }
  },
  {
    type: 'function' as const,
    name: 'get_call_duration_stats',
    description: 'Get average/median/min/max call duration, optionally within a date range and/or scoped to one agent. Use for "how long are calls" questions.',
    strict: true,
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['date_from', 'date_to', 'agent_name'],
      properties: { date_from: optionalDateParam, date_to: optionalDateParam, agent_name: { type: ['string', 'null'], description: 'Optional agent name to scope to; null for all agents.' } }
    }
  },
  {
    type: 'function' as const,
    name: 'get_flagged_call_counts',
    description: 'Count rude, escalated, recurring, and dropped calls plus urgency-level breakdown, optionally within a date range. Use for "how many rude/escalated calls" and urgency questions.',
    strict: true,
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['date_from', 'date_to'],
      properties: { date_from: optionalDateParam, date_to: optionalDateParam }
    }
  },
  {
    type: 'function' as const,
    name: 'get_customer_sentiment_breakdown',
    description: 'Get the distribution of detected tone/sentiment (e.g. angry, happy, distressed, rude) for either customers or agents, optionally within a date range. Use for "how often are customers upset" or "how often are agents rude in tone" questions.',
    strict: true,
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['date_from', 'date_to', 'speaker_role'],
      properties: { date_from: optionalDateParam, date_to: optionalDateParam, speaker_role: { type: 'string', enum: ['AGENT', 'CUSTOMER'] } }
    }
  },
  {
    type: 'function' as const,
    name: 'get_repeat_customers',
    description: 'Find customers with the most calls, optionally within a date range. Use for "who calls back the most / frequent callers" questions.',
    strict: true,
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['date_from', 'date_to', 'min_calls', 'limit'],
      properties: {
        date_from: optionalDateParam, date_to: optionalDateParam,
        min_calls: { type: 'integer', minimum: 2 }, limit: { type: 'integer', minimum: 1, maximum: 50 }
      }
    }
  },
  {
    type: 'function' as const,
    name: 'get_manager_alert_status',
    description: 'Count manager escalation alerts by status (open/in review/closed) and urgency, optionally within a date range. Use for "how many alerts are still open" questions. For the actual list of alerts to act on, use get_open_manager_alerts instead.',
    strict: true,
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['date_from', 'date_to'],
      properties: { date_from: optionalDateParam, date_to: optionalDateParam }
    }
  },
  {
    type: 'function' as const,
    name: 'get_open_manager_alerts',
    description: 'Fetch the actual open/in-review manager alerts (with call citations), most urgent and longest-waiting first. Use for "what needs my attention / what should I review today" questions.',
    strict: true,
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['status', 'urgency_level', 'limit'],
      properties: {
        status: { type: ['string', 'null'], enum: ['OPEN', 'IN_REVIEW', 'CLOSED', null], description: 'null returns both OPEN and IN_REVIEW (the default "needs attention" view).' },
        urgency_level: { type: ['string', 'null'], enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL', null] },
        limit: { type: 'integer', minimum: 1, maximum: 20 }
      }
    }
  },
  {
    type: 'function' as const,
    name: 'get_data_overview',
    description: 'Get a meta/operational summary: total calls, agents, customers, the date range the data covers, and ingestion health (batches still processing or failed, calls not yet fully processed). Use for "how much data do we have," "is our data up to date," or "any upload problems" questions. Takes no parameters.',
    strict: true,
    parameters: { type: 'object', additionalProperties: false, required: [], properties: {} }
  },
  {
    type: 'function' as const,
    name: 'get_call_evidence',
    description: 'Fetch specific calls (with title, summary, resolution, and quality feedback) matching filters, to cite as evidence for an answer. Also use this to look up calls by customer name or a specific call ID. Always call this before naming or quoting a specific call.',
    strict: true,
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['agent_name', 'resolution_status', 'issue_category', 'etiquette_rule_failed', 'date_from', 'date_to', 'customer_name', 'external_call_id', 'limit'],
      properties: {
        agent_name: { type: ['string', 'null'], description: 'Agent name (fuzzy match), or null for any agent.' },
        resolution_status: { type: ['string', 'null'], enum: [...resolutionStatuses, null] },
        issue_category: { type: ['string', 'null'], enum: [...issueCategories, null] },
        etiquette_rule_failed: { type: ['string', 'null'], enum: [...ETIQUETTE_RULE_ENUM, null], description: 'Only return calls where this rule failed.' },
        date_from: { type: ['string', 'null'], format: 'date-time' },
        date_to: { type: ['string', 'null'], format: 'date-time' },
        customer_name: { type: ['string', 'null'], description: 'Customer name (fuzzy match), or null for any customer.' },
        external_call_id: { type: ['string', 'null'], description: 'Exact call ID to look up a specific known call, or null.' },
        limit: { type: 'integer', minimum: 1, maximum: 20 }
      }
    }
  },
  {
    type: 'function' as const,
    name: 'get_recurring_verdicts',
    description: 'Fetch AI-generated verdicts, summaries, and recommended actions for recurring customer issues, already computed by the analysis pipeline. Use for "what should be improved / recurring problems" questions.',
    strict: true,
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['issue_category', 'limit'],
      properties: { issue_category: { type: ['string', 'null'], enum: [...issueCategories, null] }, limit: { type: 'integer', minimum: 1, maximum: 20 } }
    }
  },
  {
    type: 'function' as const,
    name: 'run_readonly_query',
    description: `Last resort for a question none of the other functions answer. Runs a single, read-only SQL ` +
      `SELECT/WITH query you write yourself against the analytics tables, capped at a small row count. ` +
      `Always prefer a named function above when one fits — only use this when nothing else does. ${READONLY_QUERY_SCHEMA_DOC}`,
    strict: true,
    parameters: {
      type: 'object', additionalProperties: false,
      required: ['sql', 'reason'],
      properties: {
        sql: { type: 'string', description: 'A single read-only SELECT or WITH...SELECT statement. No semicolons, no writes/DDL.' },
        reason: { type: 'string', description: 'One sentence: why no named function covers this question.' }
      }
    }
  }
];

export class ChatToolExecutionError extends Error {
  constructor(public readonly toolName: string, message: string) {
    super(message);
    this.name = 'ChatToolExecutionError';
  }
}

function nullableDate(args: Record<string, unknown>, key: string): string | null {
  return (args[key] as string | null) ?? null;
}

export async function executeChatTool(name: string, args: Record<string, unknown>, repo: ChatRepository): Promise<unknown> {
  switch (name) {
    case 'get_call_volume':
      return repo.getCallVolume(nullableDate(args, 'date_from'), nullableDate(args, 'date_to'), args.group_by as 'day' | 'week' | 'month');
    case 'rank_agents_by_quality':
      return repo.rankAgentsByQuality(nullableDate(args, 'date_from'), nullableDate(args, 'date_to'), args.order as 'best' | 'worst',
        Number(args.min_call_count), Number(args.limit));
    case 'compare_agents':
      return repo.compareAgents(args.agent_names as string[], nullableDate(args, 'date_from'), nullableDate(args, 'date_to'));
    case 'list_agents':
      return repo.listAgents(Number(args.limit));
    case 'get_agent_etiquette_breakdown':
      return repo.getAgentEtiquetteBreakdown(String(args.agent_name), nullableDate(args, 'date_from'), nullableDate(args, 'date_to'));
    case 'get_team_etiquette_failure_rates':
      return repo.getTeamEtiquetteFailureRates(nullableDate(args, 'date_from'), nullableDate(args, 'date_to'));
    case 'get_issue_category_breakdown':
      return repo.getIssueCategoryBreakdown(nullableDate(args, 'date_from'), nullableDate(args, 'date_to'), Number(args.limit));
    case 'get_resolution_breakdown':
      return repo.getResolutionBreakdown(nullableDate(args, 'date_from'), nullableDate(args, 'date_to'));
    case 'get_banking_product_breakdown':
      return repo.getBankingProductBreakdown(nullableDate(args, 'date_from'), nullableDate(args, 'date_to'), Number(args.limit));
    case 'get_device_model_breakdown':
      return repo.getDeviceModelBreakdown(nullableDate(args, 'date_from'), nullableDate(args, 'date_to'), Number(args.limit));
    case 'get_call_duration_stats':
      return repo.getCallDurationStats(nullableDate(args, 'date_from'), nullableDate(args, 'date_to'), (args.agent_name as string | null) ?? undefined);
    case 'get_flagged_call_counts':
      return repo.getFlaggedCallCounts(nullableDate(args, 'date_from'), nullableDate(args, 'date_to'));
    case 'get_customer_sentiment_breakdown':
      return repo.getCustomerSentimentBreakdown(nullableDate(args, 'date_from'), nullableDate(args, 'date_to'), args.speaker_role as 'AGENT' | 'CUSTOMER');
    case 'get_repeat_customers':
      return repo.getRepeatCustomers(nullableDate(args, 'date_from'), nullableDate(args, 'date_to'), Number(args.min_calls), Number(args.limit));
    case 'get_manager_alert_status':
      return repo.getManagerAlertStatus(nullableDate(args, 'date_from'), nullableDate(args, 'date_to'));
    case 'get_open_manager_alerts':
      return repo.getOpenManagerAlerts((args.status as string | null) ?? null, (args.urgency_level as string | null) ?? null, Number(args.limit));
    case 'get_data_overview':
      return repo.getDataOverview();
    case 'get_call_evidence':
      return repo.getCallEvidence({
        agentName: (args.agent_name as string | null) ?? undefined,
        resolutionStatus: (args.resolution_status as string | null) ?? undefined,
        issueCategory: (args.issue_category as string | null) ?? undefined,
        etiquetteRuleFailed: (args.etiquette_rule_failed as EtiquetteRule | null) ?? undefined,
        dateFrom: (args.date_from as string | null) ?? undefined,
        dateTo: (args.date_to as string | null) ?? undefined,
        customerName: (args.customer_name as string | null) ?? undefined,
        externalCallId: (args.external_call_id as string | null) ?? undefined
      }, Number(args.limit));
    case 'get_recurring_verdicts':
      return repo.getRecurringVerdicts((args.issue_category as string | null) ?? undefined, Number(args.limit));
    case 'run_readonly_query':
      try {
        return await repo.runReadonlyQuery(String(args.sql), 50);
      } catch (error) {
        return { error: error instanceof Error ? error.message : 'Query rejected' };
      }
    default:
      throw new ChatToolExecutionError(name, `Unknown tool: ${name}`);
  }
}
