import type pg from 'pg';
import type { AnalyzedCall, AnalysisInputCall } from '../services/analysis.js';

interface AnalysisInputRow {
  call_id: string;
  external_call_id: string;
  language: string;
  segment_id: string;
  segment_index: number;
  speaker_role: 'AGENT' | 'CUSTOMER';
  speaker_name: string;
  start_seconds: string;
  end_seconds: string;
  text: string;
}

export class AnalysisRepository {
  constructor(private readonly pool: pg.Pool) {}

  async pendingGroups(limit = 100): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>(
      `SELECT id FROM analysis_groups WHERE processing_state='QUEUED' ORDER BY created_at LIMIT $1`, [limit]
    );
    return result.rows.map((row) => row.id);
  }

  async createReadyGroup(maxSize: number, maxWaitMs: number, model: string,
    promptVersion: string): Promise<string | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const ready = await client.query<{ call_recording_id: string; ready_at: Date }>(
        `SELECT call_recording_id,ready_at FROM analysis_outbox
         WHERE status='READY' ORDER BY ready_at,call_recording_id
         FOR UPDATE SKIP LOCKED LIMIT $1`, [maxSize]
      );
      if (ready.rows.length === 0) {
        await client.query('ROLLBACK');
        return undefined;
      }
      const oldestAge = Date.now() - new Date(ready.rows[0]!.ready_at).getTime();
      if (ready.rows.length < maxSize && oldestAge < maxWaitMs) {
        await client.query('ROLLBACK');
        return undefined;
      }
      const group = await client.query<{ id: string }>(
        `INSERT INTO analysis_groups (model,prompt_version) VALUES ($1,$2) RETURNING id`, [model, promptVersion]
      );
      const groupId = group.rows[0]!.id;
      for (const row of ready.rows) {
        await client.query(
          `INSERT INTO analysis_group_members (analysis_group_id,call_recording_id) VALUES ($1,$2)`,
          [groupId, row.call_recording_id]
        );
      }
      const ids = ready.rows.map((row) => row.call_recording_id);
      await client.query(
        `UPDATE analysis_outbox SET status='GROUPED',analysis_group_id=$1,updated_at=now()
         WHERE call_recording_id=ANY($2::uuid[])`, [groupId, ids]
      );
      await client.query(
        `UPDATE call_recordings SET analysis_status='QUEUED',updated_at=now()
         WHERE id=ANY($1::uuid[])`, [ids]
      );
      await client.query('COMMIT');
      return groupId;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getGroupInputs(groupId: string): Promise<AnalysisInputCall[]> {
    const result = await this.pool.query<AnalysisInputRow>(
      `SELECT c.id AS call_id,c.external_call_id,c.language,s.id AS segment_id,s.segment_index,
       s.speaker_role,s.speaker_name,s.start_seconds::text,s.end_seconds::text,s.text
       FROM analysis_group_members gm
       JOIN call_recordings c ON c.id=gm.call_recording_id
       JOIN upload_batches b ON b.id=c.batch_id
       JOIN transcript_segments s ON s.call_recording_id=c.id
       WHERE gm.analysis_group_id=$1 AND b.processing_state<>'CANCELLED' ORDER BY c.id,s.segment_index`, [groupId]
    );
    const calls = new Map<string, AnalysisInputCall>();
    for (const row of result.rows) {
      let call = calls.get(row.call_id);
      if (!call) {
        call = { call_id: row.call_id, external_call_id: row.external_call_id, language: row.language, segments: [] };
        calls.set(row.call_id, call);
      }
      call.segments.push({
        segment_id: row.segment_id,
        segment_index: row.segment_index,
        speaker_role: row.speaker_role,
        speaker_name: row.speaker_name,
        start_seconds: Number(row.start_seconds),
        end_seconds: Number(row.end_seconds),
        text: row.text
      });
    }
    return [...calls.values()];
  }

  async markAnalyzing(groupId: string, attempt: number): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE analysis_groups SET processing_state='ANALYZING',attempt_count=$2,
         error_details=NULL,updated_at=now() WHERE id=$1`, [groupId, attempt]
      );
      await client.query(
        `UPDATE call_recordings c SET analysis_status='ANALYZING',analysis_attempts=$2,
         analysis_started_at=COALESCE(analysis_started_at,now()),analysis_failure_reason=NULL,updated_at=now()
         FROM analysis_group_members gm WHERE gm.analysis_group_id=$1 AND gm.call_recording_id=c.id`, [groupId, attempt]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async saveResults(groupId: string, model: string, promptVersion: string, results: AnalyzedCall[]): Promise<string[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const batchIds = new Set<string>();
      for (const result of results) {
        const state = await client.query<{ processing_state: string }>(
          `SELECT b.processing_state FROM upload_batches b JOIN call_recordings c ON c.batch_id=b.id
           WHERE c.id=$1 FOR SHARE OF b`, [result.call_id]
        );
        if (!state.rows[0] || state.rows[0].processing_state === 'CANCELLED') continue;
        const updated = await client.query<{ batch_id: string }>(
          `UPDATE call_recordings SET analysis_status='COMPLETED',analysis_failure_reason=NULL,
           analysis_model=$2,analysis_prompt_version=$3,analysis_completed_at=now(),title=$4,
           short_description=$5,issue_category=$6,issue_cause=$7,issue_summary=$8,customer_problem=$9::jsonb,
           resolution_status=$10,quality_feedback=$11,call_statuses=$12,needs_manager_attention=$13,
           urgency_level=$14,updated_at=now()
           WHERE id=$1 RETURNING batch_id`,
          [result.call_id, model, promptVersion, result.title, result.short_description, result.issue_category,
            result.issue_cause, result.issue_summary, JSON.stringify(result.customer_problem), result.resolution_status,
            result.quality_feedback, result.call_statuses, result.needs_manager_attention, result.urgency_level]
        );
        if (!updated.rows[0]) throw new Error(`Analysis call not found: ${result.call_id}`);
        batchIds.add(updated.rows[0].batch_id);
        await client.query(
          `INSERT INTO call_evaluations
           (call_recording_id,greeted_customer,introduced_self,showed_empathy,showed_empathy_applicable,
            showed_empathy_reason,offered_help,provided_clear_guidance,thanked_customer,wished_customer_good_day)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (call_recording_id) DO UPDATE SET greeted_customer=EXCLUDED.greeted_customer,
           introduced_self=EXCLUDED.introduced_self,showed_empathy=EXCLUDED.showed_empathy,
           showed_empathy_applicable=EXCLUDED.showed_empathy_applicable,
           showed_empathy_reason=EXCLUDED.showed_empathy_reason,
           offered_help=EXCLUDED.offered_help,provided_clear_guidance=EXCLUDED.provided_clear_guidance,
           thanked_customer=EXCLUDED.thanked_customer,wished_customer_good_day=EXCLUDED.wished_customer_good_day,
           updated_at=now()`,
          [result.call_id, result.rules.greeted_customer, result.rules.introduced_self,
            result.rules.showed_empathy, result.rules.showed_empathy_applicable, result.rules.showed_empathy_reason,
            result.rules.offered_help, result.rules.provided_clear_guidance, result.rules.thanked_customer,
            result.rules.wished_customer_good_day]
        );
        for (const tone of result.segment_tones) {
          const segment = await client.query(
            `UPDATE transcript_segments SET textual_tone=$3,updated_at=now()
             WHERE id=$1 AND call_recording_id=$2`, [tone.segment_id, result.call_id, tone.textual_tone]
          );
          if (segment.rowCount !== 1) throw new Error(`Analysis segment not found: ${tone.segment_id}`);
        }
        if (result.needs_manager_attention) {
          await client.query(
            `INSERT INTO manager_alerts (call_recording_id,urgency_level) VALUES ($1,$2)
             ON CONFLICT (call_recording_id) DO UPDATE SET urgency_level=EXCLUDED.urgency_level,status='OPEN',
             reviewed_at=NULL,updated_at=now()`,
            [result.call_id, result.urgency_level]
          );
        } else {
          await client.query(`DELETE FROM manager_alerts WHERE call_recording_id=$1 AND status='OPEN'`, [result.call_id]);
        }
      }
      await client.query(
        `UPDATE analysis_groups SET processing_state='COMPLETED',error_details=NULL,
         completed_at=now(),updated_at=now() WHERE id=$1`, [groupId]
      );
      await client.query('COMMIT');
      return [...batchIds];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async failOrSplitGroup(groupId: string, reason: string, model: string,
    promptVersion: string): Promise<{ splitGroupIds: string[]; batchIds: string[] }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const members = await client.query<{ call_recording_id: string; batch_id: string }>(
        `SELECT gm.call_recording_id,c.batch_id FROM analysis_group_members gm
         JOIN call_recordings c ON c.id=gm.call_recording_id WHERE gm.analysis_group_id=$1`, [groupId]
      );
      const batchIds = [...new Set(members.rows.map((row) => row.batch_id))];
      if (members.rows.length > 1) {
        const splitGroupIds: string[] = [];
        for (const member of members.rows) {
          const split = await client.query<{ id: string }>(
            `INSERT INTO analysis_groups (model,prompt_version) VALUES ($1,$2) RETURNING id`, [model, promptVersion]
          );
          splitGroupIds.push(split.rows[0]!.id);
          await client.query(
            `INSERT INTO analysis_group_members (analysis_group_id,call_recording_id) VALUES ($1,$2)`,
            [split.rows[0]!.id, member.call_recording_id]
          );
        }
        await client.query(
          `UPDATE analysis_groups SET processing_state='SPLIT',error_details=$2::jsonb,
           completed_at=now(),updated_at=now() WHERE id=$1`, [groupId, JSON.stringify({ message: reason })]
        );
        await client.query(
          `UPDATE call_recordings c SET analysis_status='QUEUED',analysis_failure_reason=$2,updated_at=now()
           FROM analysis_group_members gm WHERE gm.analysis_group_id=$1 AND gm.call_recording_id=c.id`, [groupId, reason]
        );
        await client.query('COMMIT');
        return { splitGroupIds, batchIds };
      }
      await client.query(
        `UPDATE analysis_groups SET processing_state='FAILED',error_details=$2::jsonb,
         completed_at=now(),updated_at=now() WHERE id=$1`, [groupId, JSON.stringify({ message: reason })]
      );
      await client.query(
        `UPDATE call_recordings c SET analysis_status='FAILED',analysis_failure_reason=$2,
         analysis_completed_at=now(),updated_at=now()
         FROM analysis_group_members gm WHERE gm.analysis_group_id=$1 AND gm.call_recording_id=c.id`, [groupId, reason]
      );
      await client.query('COMMIT');
      return { splitGroupIds: [], batchIds };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async refreshBatchState(batchId: string): Promise<void> {
    await this.pool.query(
      `UPDATE upload_batches b SET processing_state=CASE
         WHEN EXISTS (SELECT 1 FROM call_recordings c WHERE c.batch_id=b.id
           AND c.transcription_status IN ('PENDING','QUEUED','TRANSCRIBING')) THEN 'TRANSCRIBING'
         WHEN EXISTS (SELECT 1 FROM call_recordings c WHERE c.batch_id=b.id AND c.transcription_status='COMPLETED'
           AND c.analysis_status IN ('PENDING','QUEUED','ANALYZING')) THEN 'ANALYZING'
         WHEN EXISTS (SELECT 1 FROM call_recordings c WHERE c.batch_id=b.id
           AND (c.transcription_status='FAILED' OR c.analysis_status='FAILED')) THEN 'COMPLETED_WITH_FAILURES'
         ELSE 'COMPLETED' END,
       completed_at=CASE WHEN EXISTS (SELECT 1 FROM call_recordings c WHERE c.batch_id=b.id
         AND (c.transcription_status IN ('PENDING','QUEUED','TRANSCRIBING') OR
           (c.transcription_status='COMPLETED' AND c.analysis_status IN ('PENDING','QUEUED','ANALYZING'))))
         THEN NULL ELSE now() END,updated_at=now()
       WHERE b.id=$1 AND b.ingestion_state IN ('COMPLETED','PARTIAL')`, [batchId]
    );
  }

  async getCallAnalysis(callId: string): Promise<Record<string, unknown> | undefined> {
    const call = await this.pool.query(
      `SELECT c.id AS recording_id,c.external_call_id,c.analysis_status,c.analysis_failure_reason,
       c.analysis_model,c.analysis_prompt_version,c.title,c.short_description,c.issue_category,c.issue_cause,
       c.issue_summary,c.customer_problem,c.resolution_status,c.quality_feedback,c.call_statuses,
       c.needs_manager_attention,c.urgency_level,
       e.greeted_customer,e.introduced_self,e.showed_empathy,e.showed_empathy_applicable,
       e.showed_empathy_reason,e.offered_help,e.provided_clear_guidance,
       e.thanked_customer,e.wished_customer_good_day
       FROM call_recordings c LEFT JOIN call_evaluations e ON e.call_recording_id=c.id
       WHERE c.id::text=$1 OR c.external_call_id=$1`, [callId]
    );
    if (!call.rows[0]) return undefined;
    const row = call.rows[0] as Record<string, unknown>;
    const rules = row.greeted_customer === null || row.greeted_customer === undefined ? null : {
      greeted_customer: row.greeted_customer, introduced_self: row.introduced_self,
      showed_empathy: row.showed_empathy, showed_empathy_applicable: row.showed_empathy_applicable,
      showed_empathy_reason: row.showed_empathy_reason, offered_help: row.offered_help,
      provided_clear_guidance: row.provided_clear_guidance, thanked_customer: row.thanked_customer,
      wished_customer_good_day: row.wished_customer_good_day
    };
    for (const key of ['greeted_customer', 'introduced_self', 'showed_empathy', 'showed_empathy_applicable',
      'showed_empathy_reason', 'offered_help',
      'provided_clear_guidance', 'thanked_customer', 'wished_customer_good_day']) delete row[key];
    return { ...row, status: resolutionStatusValue(row.resolution_status),
      status_label: resolutionStatusLabel(row.resolution_status), rules };
  }
}

function resolutionStatusValue(value: unknown): string {
  return String(value ?? 'UNKNOWN').toLowerCase();
}

function resolutionStatusLabel(value: unknown): string {
  if (value === 'RESOLVED_BUT_IMPROVE_QUALITY') return 'Resolved but Improve Quality';
  return String(value ?? 'UNKNOWN').toLowerCase().replaceAll('_', ' ').replace(/^./u, (letter) => letter.toUpperCase());
}
