import type pg from 'pg';

export interface CallListFilters {
  batchId?: string;
  customerId?: string;
  agentId?: string;
  issueCategory?: string;
  deviceModel?: string;
  bankingProduct?: string;
  resolutionStatus?: string;
  callStatus?: string;
  needsManagerAttention?: boolean;
  urgencyLevel?: string;
  processingState?: string;
  startedFrom?: string;
  startedTo?: string;
  page: number;
  pageSize: number;
}

const processingStateSql = `CASE
  WHEN c.transcription_status='FAILED' OR c.analysis_status='FAILED' OR c.recurrence_status='FAILED' THEN 'FAILED'
  WHEN c.transcription_status IN ('PENDING','QUEUED','TRANSCRIBING') THEN 'TRANSCRIBING'
  WHEN c.analysis_status IN ('PENDING','QUEUED','ANALYZING') THEN 'ANALYZING'
  WHEN c.recurrence_status IN ('PENDING','QUEUED','LINKING') THEN 'LINKING_RECURRING_CALLS'
  ELSE 'COMPLETED' END`;

export type GroupedCallStatusFilter = 'resolved' | 'improve_quality' | 'recurring' | 'attention'
  | 'unresolved' | 'analysis_failed' | 'dropped' | 'rude';

/**
 * Mirrors the frontend's status-derivation priority chain for individual
 * statuses (see callStatusFromBackend/statusFromRecurringOutcome in
 * mappers.ts). The attention filter is intentionally cross-cutting: it
 * returns the union of recurring, rude and unresolved calls represented by
 * the homepage's Requires attention tile.
 * Calls and recurring groups use
 * different status columns (call_recordings vs. recurring_call_groups),
 * so each filter needs a clause for both branches of the calls-grouped
 * UNION — groups have no needs_manager_attention/analysis_status/rude
 * concept, so several filters can never match a group, matching today's
 * client-side behavior exactly.
 */
function groupedFilterClauses(filter: GroupedCallStatusFilter | undefined): { callClause: string; groupClause: string } {
  // Except for the cross-cutting attention filter, each call clause explicitly excludes every higher-priority category in the
  // chain (DROPPED > RECURRING > IMPROVE_QUALITY > ATTENTION > RESOLVED >
  // everything else = UNRESOLVED), not just its own positive condition —
  // otherwise a call matching two conditions (e.g. RESOLVED_BUT_IMPROVE_QUALITY
  // *and* needs_manager_attention) would double-count under both filters
  // instead of the one the frontend's priority chain actually picks.
  const notFailed = `c.analysis_status<>'FAILED'`;
  const notDropped = `c.resolution_status<>'DROPPED'`;
  const notRecurring = `NOT('RECURRING'=ANY(c.call_statuses))`;
  const notImproveQuality = `c.resolution_status<>'RESOLVED_BUT_IMPROVE_QUALITY'`;
  const notAttention = `NOT c.needs_manager_attention`;
  switch (filter) {
    case 'dropped':
      return { callClause: `${notFailed} AND c.resolution_status='DROPPED'`, groupClause: `g.outcome_status='DROPPED'` };
    case 'recurring':
      return {
        callClause: `${notFailed} AND ${notDropped} AND 'RECURRING'=ANY(c.call_statuses)`,
        groupClause: `g.outcome_status NOT IN ('RESOLVED','RESOLVED_BUT_IMPROVE_QUALITY','DROPPED','ESCALATED')`
      };
    case 'improve_quality':
      return {
        callClause: `${notFailed} AND ${notDropped} AND ${notRecurring} AND c.resolution_status='RESOLVED_BUT_IMPROVE_QUALITY'`,
        groupClause: `g.outcome_status='RESOLVED_BUT_IMPROVE_QUALITY'`
      };
    case 'attention':
      return {
        callClause: `${notFailed} AND (
          'RECURRING'=ANY(c.call_statuses)
          OR 'RUDE'=ANY(c.call_statuses)
          OR c.resolution_status='UNRESOLVED'
        )`,
        groupClause: 'true'
      };
    case 'resolved':
      return {
        callClause: `${notFailed} AND ${notDropped} AND ${notRecurring} AND ${notImproveQuality} AND ${notAttention} AND c.resolution_status='RESOLVED'`,
        groupClause: `g.outcome_status='RESOLVED'`
      };
    case 'unresolved':
      return {
        callClause: `${notFailed} AND ${notDropped} AND ${notRecurring} AND ${notImproveQuality} AND ${notAttention} AND c.resolution_status<>'RESOLVED'`,
        groupClause: 'false'
      };
    case 'analysis_failed':
      return { callClause: `c.analysis_status='FAILED'`, groupClause: 'false' };
    case 'rude':
      return { callClause: `${notFailed} AND 'RUDE'=ANY(c.call_statuses)`, groupClause: 'false' };
    default:
      return { callClause: 'true', groupClause: 'true' };
  }
}

export class CallRepository {
  constructor(private readonly pool: pg.Pool) {}

  async listGrouped(page: number, pageSize: number, startedFrom?: string, startedTo?: string,
    statusFilter?: GroupedCallStatusFilter): Promise<{
    items: Record<string, unknown>[]; pagination: Record<string, number>
  }> {
    const offset = (page - 1) * pageSize;
    const { callClause, groupClause } = groupedFilterClauses(statusFilter);
    const entries = await this.pool.query<{ item_type: 'CALL' | 'RECURRING_GROUP'; id: string; total_count: number }>(
      `WITH list_entries AS (
         SELECT 'RECURRING_GROUP'::text AS item_type,g.id,g.created_at AS sort_at
         FROM recurring_call_groups g
         WHERE ${groupClause}
         UNION ALL
         SELECT 'CALL'::text,c.id,c.created_at AS sort_at FROM call_recordings c
         WHERE NOT EXISTS (SELECT 1 FROM recurring_call_members m WHERE m.call_recording_id=c.id)
           AND (${callClause})
       )
       SELECT item_type,id,count(*) OVER()::integer AS total_count FROM list_entries
       WHERE ($3::timestamptz IS NULL OR sort_at >= $3) AND ($4::timestamptz IS NULL OR sort_at <= $4)
       ORDER BY sort_at DESC,id LIMIT $1 OFFSET $2`, [pageSize, offset, startedFrom ?? null, startedTo ?? null]
    );
    const items = await Promise.all(entries.rows.map(async (entry) => {
      if (entry.item_type === 'RECURRING_GROUP') {
        const result = await this.pool.query(
           `SELECT 'RECURRING_GROUP' AS item_type,g.id,g.group_title AS title,g.summary AS short_description,
           g.verdict,g.recommended_action,g.outcome_status,g.issue_category,g.issue_cause,g.first_call_at,g.latest_call_at,
           g.lookback_days,count(m.call_recording_id)::integer AS call_count,
           coalesce(sum(t.duration_seconds),0) AS duration_seconds,cu.id AS customer_id,
           cu.external_id AS customer_external_id,cu.name AS customer_name,
           count(DISTINCT c.agent_id)::integer AS agent_count,
           string_agg(DISTINCT coalesce(a.name,a.external_id),', ' ORDER BY coalesce(a.name,a.external_id)) AS agent_name,
           jsonb_agg(jsonb_build_object(
             'sequence_number',m.sequence_number,'id',c.id,'title',c.title,'started_at',c.started_at,
             'resolution_status',c.resolution_status
           ) ORDER BY m.sequence_number) AS calls
           FROM recurring_call_groups g JOIN customers cu ON cu.id=g.customer_id
           JOIN recurring_call_members m ON m.recurring_group_id=g.id
           JOIN call_recordings c ON c.id=m.call_recording_id JOIN agents a ON a.id=c.agent_id
           LEFT JOIN transcripts t ON t.call_recording_id=c.id WHERE g.id=$1
           GROUP BY g.id,cu.id`, [entry.id]
        );
        return result.rows[0] as Record<string, unknown>;
      }
      const result = await this.pool.query(
        `SELECT 'CALL' AS item_type,c.id,c.external_call_id,c.batch_id,c.started_at,c.language,
         coalesce(nullif(btrim(c.device_model),''),'GENERAL') AS device_model,
         coalesce(nullif(btrim(c.banking_product),''),'GENERAL_BANKING') AS banking_product,t.duration_seconds,
         c.title,c.short_description,c.issue_category,c.issue_cause,c.customer_problem,c.resolution_status,c.quality_feedback,c.call_statuses,
         c.needs_manager_attention,c.urgency_level,${processingStateSql} AS processing_state,
         c.transcription_status,c.analysis_status,c.recurrence_status,
         cu.id AS customer_id,cu.external_id AS customer_external_id,cu.name AS customer_name,
         a.id AS agent_id,a.external_id AS agent_external_id,a.name AS agent_name
         FROM call_recordings c JOIN customers cu ON cu.id=c.customer_id JOIN agents a ON a.id=c.agent_id
         LEFT JOIN transcripts t ON t.call_recording_id=c.id WHERE c.id=$1`, [entry.id]
      );
      return withResolutionAliases(result.rows[0] as Record<string, unknown>);
    }));
    const total = Number(entries.rows[0]?.total_count ?? 0);
    return { items, pagination: { page, page_size: pageSize, total, total_pages: Math.ceil(total / pageSize) } };
  }

  async getRecurringGroup(groupId: string): Promise<Record<string, unknown> | undefined> {
    const group = await this.pool.query(
      `SELECT g.id,g.group_title,g.summary,g.verdict,g.recommended_action,g.issue_category,g.issue_cause,
       g.outcome_status,g.first_call_at,g.latest_call_at,g.lookback_days,g.analysis_model,g.analysis_prompt_version,
       cu.id AS customer_id,cu.external_id AS customer_external_id,cu.name AS customer_name
       FROM recurring_call_groups g JOIN customers cu ON cu.id=g.customer_id WHERE g.id=$1`, [groupId]
    );
    if (!group.rows[0]) return undefined;
    const calls = await this.pool.query(
      `SELECT m.sequence_number,c.id,c.external_call_id,c.started_at,c.title,c.short_description,c.issue_summary,
       c.issue_category,c.issue_cause,c.resolution_status,c.call_statuses,c.needs_manager_attention,c.urgency_level,
       t.duration_seconds,a.id AS agent_id,a.external_id AS agent_external_id,a.name AS agent_name
       FROM recurring_call_members m JOIN call_recordings c ON c.id=m.call_recording_id
       JOIN agents a ON a.id=c.agent_id LEFT JOIN transcripts t ON t.call_recording_id=c.id
       WHERE m.recurring_group_id=$1 ORDER BY m.sequence_number`, [groupId]
    );
    return { ...group.rows[0], call_count: calls.rows.length, calls: calls.rows };
  }

  async list(filters: CallListFilters): Promise<{ items: Record<string, unknown>[]; pagination: Record<string, number> }> {
    const clauses: string[] = [];
    const values: unknown[] = [];
    const add = (sql: string, value: unknown): void => {
      values.push(value);
      clauses.push(sql.replace('?', `$${values.length}`));
    };
    if (filters.batchId) add('c.batch_id=?', filters.batchId);
    if (filters.customerId) add('c.customer_id=?', filters.customerId);
    if (filters.agentId) {
      values.push(filters.agentId);
      clauses.push(`(c.agent_id::text=$${values.length} OR a.external_id=$${values.length})`);
    }
    if (filters.issueCategory) add('c.issue_category=?', filters.issueCategory);
    if (filters.deviceModel) add(`coalesce(nullif(btrim(c.device_model),''),'GENERAL')=?`, filters.deviceModel);
    if (filters.bankingProduct) add(`coalesce(nullif(btrim(c.banking_product),''),'GENERAL_BANKING')=?`, filters.bankingProduct);
    if (filters.resolutionStatus) add('c.resolution_status=?', filters.resolutionStatus);
    if (filters.callStatus) add('?=ANY(c.call_statuses)', filters.callStatus);
    if (filters.needsManagerAttention !== undefined) add('c.needs_manager_attention=?', filters.needsManagerAttention);
    if (filters.urgencyLevel) add('c.urgency_level=?', filters.urgencyLevel);
    if (filters.processingState) add(`${processingStateSql}=?`, filters.processingState);
    if (filters.startedFrom) add('c.started_at>=?', filters.startedFrom);
    if (filters.startedTo) add('c.started_at<=?', filters.startedTo);
    values.push(filters.pageSize, (filters.page - 1) * filters.pageSize);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT c.id,c.external_call_id,c.batch_id,c.started_at,c.language,
       coalesce(nullif(btrim(c.device_model),''),'GENERAL') AS device_model,
       coalesce(nullif(btrim(c.banking_product),''),'GENERAL_BANKING') AS banking_product,t.duration_seconds,
       c.title,c.short_description,c.issue_category,c.issue_cause,c.customer_problem,c.resolution_status,c.quality_feedback,c.call_statuses,
       c.needs_manager_attention,c.urgency_level,${processingStateSql} AS processing_state,
       c.transcription_status,c.analysis_status,c.recurrence_status,
       cu.id AS customer_id,cu.external_id AS customer_external_id,cu.name AS customer_name,
       a.id AS agent_id,a.external_id AS agent_external_id,a.name AS agent_name,
       count(*) OVER()::integer AS total_count
       FROM call_recordings c JOIN customers cu ON cu.id=c.customer_id JOIN agents a ON a.id=c.agent_id
       LEFT JOIN transcripts t ON t.call_recording_id=c.id
       ${where} ORDER BY c.created_at DESC,c.id LIMIT $${values.length - 1} OFFSET $${values.length}`, values
    );
    const total = Number(result.rows[0]?.total_count ?? 0);
    const items = result.rows.map((row: Record<string, unknown>) => {
      const { total_count: _total, ...item } = row;
      return withResolutionAliases(item);
    });
    return {
      items,
      pagination: { page: filters.page, page_size: filters.pageSize, total, total_pages: Math.ceil(total / filters.pageSize) }
    };
  }

  async getDetail(callId: string): Promise<Record<string, unknown> | undefined> {
    const callResult = await this.pool.query(
      `SELECT c.id,c.external_call_id,c.batch_id,c.original_filename,c.audio_format,c.audio_bytes,c.recording_url,
       c.validation_status,c.language,coalesce(nullif(btrim(c.device_model),''),'GENERAL') AS device_model,
       coalesce(nullif(btrim(c.banking_product),''),'GENERAL_BANKING') AS banking_product,
       c.channel_layout,c.customer_channel,c.agent_channel,c.source_caller_speaker_id,c.source_agent_speaker_id,
       c.started_at,c.raw_metadata,c.created_at,c.updated_at,
       c.title,c.short_description,c.issue_category,c.issue_cause,c.issue_summary,c.customer_problem,
       c.resolution_status,c.quality_feedback,c.call_statuses,
       c.needs_manager_attention,c.urgency_level,c.transcription_status,c.transcription_failure_reason,
       c.analysis_status,c.analysis_failure_reason,c.recurrence_status,c.recurrence_failure_reason,
       ${processingStateSql} AS processing_state,
       cu.id AS customer_id,cu.external_id AS customer_external_id,cu.name AS customer_name,
       a.id AS agent_id,a.external_id AS agent_external_id,a.name AS agent_name,
       t.id AS transcript_id,t.full_text,t.language AS transcript_language,t.duration_seconds,t.segment_count,
       e.greeted_customer,e.introduced_self,e.showed_empathy,e.showed_empathy_applicable,
       e.showed_empathy_reason,e.offered_help,e.provided_clear_guidance,
       e.thanked_customer,e.wished_customer_good_day,
       ma.id AS manager_alert_id,ma.status AS manager_alert_status,ma.manager_notes,ma.reviewed_at
       FROM call_recordings c JOIN customers cu ON cu.id=c.customer_id JOIN agents a ON a.id=c.agent_id
       LEFT JOIN transcripts t ON t.call_recording_id=c.id
       LEFT JOIN call_evaluations e ON e.call_recording_id=c.id
       LEFT JOIN manager_alerts ma ON ma.call_recording_id=c.id
       WHERE c.id::text=$1 OR c.external_call_id=$1`, [callId]
    );
    if (!callResult.rows[0]) return undefined;
    const row = callResult.rows[0] as Record<string, unknown>;
    const recordingId = row.id as string;
    const segmentsResult = await this.pool.query(
      `SELECT id AS segment_id,segment_index,provider_speaker_label,speaker_role,speaker_name,
       start_seconds,end_seconds,text,textual_tone FROM transcript_segments
       WHERE call_recording_id=$1 ORDER BY segment_index`, [recordingId]
    );
    const recurringResult = await this.pool.query(
      `SELECT g.id AS group_id,g.group_title,g.summary,g.verdict,g.recommended_action,g.outcome_status,
       g.issue_category,g.issue_cause,g.first_call_at,g.latest_call_at,g.lookback_days,
       m.sequence_number,related.id AS call_id,related.external_call_id,related.started_at,related.resolution_status
       FROM recurring_call_groups g
       JOIN recurring_call_members own ON own.recurring_group_id=g.id AND own.call_recording_id=$1
       JOIN recurring_call_members m ON m.recurring_group_id=g.id
       JOIN call_recordings related ON related.id=m.call_recording_id
       ORDER BY g.latest_call_at DESC,m.sequence_number`, [recordingId]
    );
    const groups = new Map<string, Record<string, unknown>>();
    for (const recurring of recurringResult.rows as Record<string, unknown>[]) {
      let group = groups.get(recurring.group_id as string);
      if (!group) {
        group = {
          group_id: recurring.group_id, issue_category: recurring.issue_category, issue_cause: recurring.issue_cause,
          group_title: recurring.group_title, summary: recurring.summary, verdict: recurring.verdict,
          recommended_action: recurring.recommended_action, outcome_status: recurring.outcome_status,
          first_call_at: recurring.first_call_at, latest_call_at: recurring.latest_call_at,
          lookback_days: recurring.lookback_days, calls: [] as Record<string, unknown>[]
        };
        groups.set(recurring.group_id as string, group);
      }
      (group.calls as Record<string, unknown>[]).push({
        sequence_number: recurring.sequence_number, call_id: recurring.call_id,
        external_call_id: recurring.external_call_id, started_at: recurring.started_at,
        resolution_status: recurring.resolution_status
      });
    }
    const rules = row.greeted_customer === null || row.greeted_customer === undefined ? null : {
      greeted_customer: row.greeted_customer, introduced_self: row.introduced_self,
      showed_empathy: row.showed_empathy, showed_empathy_applicable: row.showed_empathy_applicable,
      showed_empathy_reason: row.showed_empathy_reason, offered_help: row.offered_help,
      provided_clear_guidance: row.provided_clear_guidance, thanked_customer: row.thanked_customer,
      wished_customer_good_day: row.wished_customer_good_day
    };
    const managerAlert = row.manager_alert_id ? {
      id: row.manager_alert_id, status: row.manager_alert_status, manager_notes: row.manager_notes,
      reviewed_at: row.reviewed_at
    } : null;
    for (const key of ['greeted_customer', 'introduced_self', 'showed_empathy', 'showed_empathy_applicable',
      'showed_empathy_reason', 'offered_help',
      'provided_clear_guidance', 'thanked_customer', 'wished_customer_good_day', 'manager_alert_id',
      'manager_alert_status', 'manager_notes', 'reviewed_at']) delete row[key];
    return { ...row, status: resolutionStatusValue(row.resolution_status),
      status_label: resolutionStatusLabel(row.resolution_status), rules, manager_alert: managerAlert,
      segments: segmentsResult.rows, recurring_groups: [...groups.values()] };
  }

  async getAudio(callId: string): Promise<{
    objectKey: string; filename: string; audioFormat: string; bytes: number
  } | undefined> {
    const result = await this.pool.query<{
      object_key: string; original_filename: string; audio_format: string; audio_bytes: string
    }>(
      `SELECT object_key,original_filename,audio_format,audio_bytes::text FROM call_recordings
       WHERE id::text=$1 OR external_call_id=$1`, [callId]
    );
    const row = result.rows[0];
    return row ? {
      objectKey: row.object_key, filename: row.original_filename,
      audioFormat: row.audio_format, bytes: Number(row.audio_bytes)
    } : undefined;
  }

  async listManagerAlerts(status: string | undefined, urgency: string | undefined, page: number, pageSize: number) {
    const values: unknown[] = [];
    const clauses: string[] = [];
    if (status) { values.push(status); clauses.push(`ma.status=$${values.length}`); }
    if (urgency) { values.push(urgency); clauses.push(`ma.urgency_level=$${values.length}`); }
    values.push(pageSize, (page - 1) * pageSize);
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await this.pool.query(
      `SELECT ma.id,ma.call_recording_id,c.external_call_id,c.title,c.short_description,c.started_at,
       ma.urgency_level,ma.status,ma.manager_notes,ma.reviewed_at,ma.created_at,ma.updated_at,
       cu.external_id AS customer_external_id,cu.name AS customer_name,
       a.external_id AS agent_external_id,a.name AS agent_name,count(*) OVER()::integer AS total_count
       FROM manager_alerts ma JOIN call_recordings c ON c.id=ma.call_recording_id
       JOIN customers cu ON cu.id=c.customer_id JOIN agents a ON a.id=c.agent_id
       ${where} ORDER BY CASE ma.urgency_level WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2
       WHEN 'MEDIUM' THEN 3 ELSE 4 END,ma.created_at
       LIMIT $${values.length - 1} OFFSET $${values.length}`, values
    );
    const total = Number(result.rows[0]?.total_count ?? 0);
    return {
      items: result.rows.map((row: Record<string, unknown>) => {
        const { total_count: _total, ...item } = row;
        return item;
      }),
      pagination: { page, page_size: pageSize, total, total_pages: Math.ceil(total / pageSize) }
    };
  }

  async updateManagerAlert(alertId: string, status: string, managerNotes?: string | null): Promise<Record<string, unknown> | undefined> {
    const result = await this.pool.query(
      `UPDATE manager_alerts SET status=$2,manager_notes=CASE WHEN $3::boolean THEN $4 ELSE manager_notes END,
       reviewed_at=CASE WHEN $2='CLOSED' THEN now() ELSE NULL END,updated_at=now()
       WHERE id=$1 RETURNING id,call_recording_id,urgency_level,status,manager_notes,reviewed_at,created_at,updated_at`,
      [alertId, status, managerNotes !== undefined, managerNotes ?? null]
    );
    return result.rows[0];
  }
}

function resolutionStatusValue(value: unknown): string {
  return String(value ?? 'UNKNOWN').toLowerCase();
}

function withResolutionAliases<T extends Record<string, unknown>>(row: T): T & { status: string; status_label: string } {
  return { ...row, status: resolutionStatusValue(row.resolution_status),
    status_label: resolutionStatusLabel(row.resolution_status) };
}

function resolutionStatusLabel(value: unknown): string {
  if (value === 'RESOLVED_BUT_IMPROVE_QUALITY') return 'Resolved but Improve Quality';
  return String(value ?? 'UNKNOWN').toLowerCase().replaceAll('_', ' ').replace(/^./u, (letter) => letter.toUpperCase());
}
