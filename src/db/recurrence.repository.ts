import type pg from 'pg';
import type { RecurrenceReviewCall, RecurrenceReviewGroup } from '../services/recurrence-analysis.js';

export interface RecurrenceJobData {
  batchId: string;
  customerId: string;
}

export class RecurrenceRepository {
  constructor(private readonly pool: pg.Pool) {}

  async prepareBatch(batchId: string): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`batch:${batchId}`]);
      const batch = await client.query<{ ingestion_state: string }>(
        `SELECT ingestion_state FROM upload_batches WHERE id=$1 FOR UPDATE`, [batchId]
      );
      if (!batch.rows[0] || !['COMPLETED', 'PARTIAL'].includes(batch.rows[0].ingestion_state)) {
        await client.query('ROLLBACK');
        return false;
      }
      const unfinished = await client.query(
        `SELECT 1 FROM call_recordings WHERE batch_id=$1 AND (
           transcription_status IN ('PENDING','QUEUED','TRANSCRIBING') OR
           (transcription_status='COMPLETED' AND analysis_status IN ('PENDING','QUEUED','ANALYZING'))
         ) LIMIT 1`, [batchId]
      );
      if ((unfinished.rowCount ?? 0) > 0) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(
        `INSERT INTO recurrence_jobs (batch_id,customer_id)
         SELECT DISTINCT batch_id,customer_id FROM call_recordings
         WHERE batch_id=$1 AND analysis_status='COMPLETED'
         ON CONFLICT (batch_id,customer_id) DO UPDATE SET status='PENDING',attempt_count=0,last_error=NULL,
         dispatched_at=NULL,started_at=NULL,completed_at=NULL,updated_at=now()`, [batchId]
      );
      await client.query(
        `UPDATE call_recordings c SET recurrence_status='QUEUED',recurrence_failure_reason=NULL,updated_at=now()
         FROM recurrence_jobs r WHERE r.batch_id=$1 AND r.batch_id=c.batch_id AND r.customer_id=c.customer_id
         AND c.analysis_status='COMPLETED' AND c.recurrence_status IN ('PENDING','COMPLETED','FAILED')
         AND r.status IN ('PENDING','DISPATCHED','RUNNING')`, [batchId]
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async pendingJobs(limit = 100): Promise<RecurrenceJobData[]> {
    const result = await this.pool.query<{ batch_id: string; customer_id: string }>(
      `SELECT batch_id,customer_id FROM recurrence_jobs WHERE status='PENDING'
       ORDER BY created_at,batch_id,customer_id LIMIT $1`, [limit]
    );
    return result.rows.map((row) => ({ batchId: row.batch_id, customerId: row.customer_id }));
  }

  async markDispatched(data: RecurrenceJobData): Promise<void> {
    await this.pool.query(
      `UPDATE recurrence_jobs SET status='DISPATCHED',dispatched_at=now(),last_error=NULL,updated_at=now()
       WHERE batch_id=$1 AND customer_id=$2 AND status='PENDING'`, [data.batchId, data.customerId]
    );
  }

  async markDispatchError(data: RecurrenceJobData, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE recurrence_jobs SET last_error=$3,updated_at=now()
       WHERE batch_id=$1 AND customer_id=$2 AND status='PENDING'`, [data.batchId, data.customerId, reason]
    );
  }

  async markRunning(data: RecurrenceJobData, attempt: number): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE recurrence_jobs SET status='RUNNING',attempt_count=$3,started_at=COALESCE(started_at,now()),
         last_error=NULL,updated_at=now() WHERE batch_id=$1 AND customer_id=$2`,
        [data.batchId, data.customerId, attempt]
      );
      await client.query(
        `UPDATE call_recordings SET recurrence_status='LINKING',recurrence_failure_reason=NULL,updated_at=now()
         WHERE batch_id=$1 AND customer_id=$2 AND analysis_status='COMPLETED'`, [data.batchId, data.customerId]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getCustomerCandidates(data: RecurrenceJobData, lookbackDays: number): Promise<RecurrenceReviewCall[]> {
    const anchorResult = await this.pool.query<{ anchor: Date | null }>(
      `SELECT max(started_at) AS anchor FROM call_recordings
       WHERE batch_id=$1 AND customer_id=$2 AND analysis_status='COMPLETED'`, [data.batchId, data.customerId]
    );
    const anchor = anchorResult.rows[0]?.anchor;
    if (!anchor) return [];
    const result = await this.pool.query<RecurrenceReviewCall>(
      `SELECT id AS call_id,external_call_id,started_at,
       coalesce(title,'Call') AS title,coalesce(short_description,'') AS short_description,
       coalesce(issue_category,'OTHER') AS issue_category,coalesce(issue_cause,'UNKNOWN') AS issue_cause,
       coalesce(issue_summary,short_description,title,'No issue summary') AS issue_summary,
       coalesce(resolution_status,'UNKNOWN') AS resolution_status
       FROM call_recordings WHERE customer_id=$1 AND analysis_status='COMPLETED' AND started_at<=$2
       AND started_at >= $2 - ($3 * interval '1 day') ORDER BY started_at,id`,
      [data.customerId, anchor, lookbackDays]
    );
    return result.rows.map((row) => ({ ...row, started_at: new Date(row.started_at) }));
  }

  async saveCustomerReview(data: RecurrenceJobData, lookbackDays: number, candidates: RecurrenceReviewCall[],
    groups: RecurrenceReviewGroup[], model: string, promptVersion: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const batch = await client.query<{ processing_state: string }>(
        'SELECT processing_state FROM upload_batches WHERE id=$1 FOR SHARE', [data.batchId]
      );
      if (!batch.rows[0] || batch.rows[0].processing_state === 'CANCELLED') {
        await client.query('ROLLBACK');
        return;
      }
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`customer:${data.customerId}`]);
      const candidateIds = candidates.map((call) => call.call_id);
      if (candidateIds.length > 0) {
        const staleMembers = await client.query<{ call_recording_id: string }>(
          `SELECT DISTINCT all_members.call_recording_id FROM recurring_call_groups g
           JOIN recurring_call_members matched ON matched.recurring_group_id=g.id
           JOIN recurring_call_members all_members ON all_members.recurring_group_id=g.id
           WHERE g.customer_id=$1 AND matched.call_recording_id=ANY($2::uuid[])`,
          [data.customerId, candidateIds]
        );
        await client.query(
          `DELETE FROM recurring_call_groups g WHERE g.customer_id=$1 AND EXISTS (
             SELECT 1 FROM recurring_call_members m WHERE m.recurring_group_id=g.id
             AND m.call_recording_id=ANY($2::uuid[]))`, [data.customerId, candidateIds]
        );
        const staleIds = staleMembers.rows.map((row) => row.call_recording_id);
        if (staleIds.length > 0) {
          await client.query(
            `UPDATE call_recordings SET call_statuses=array_remove(call_statuses,'RECURRING'),updated_at=now()
             WHERE id=ANY($1::uuid[])`, [staleIds]
          );
        }
        const byId = new Map(candidates.map((call) => [call.call_id, call]));
        for (const review of groups) {
          const calls = review.call_ids.map((id) => byId.get(id)!);
          const firstCallAt = calls[0]!.started_at;
          const latestCallAt = calls[calls.length - 1]!.started_at;
          const group = await client.query<{ id: string }>(
            `INSERT INTO recurring_call_groups
             (customer_id,issue_category,issue_cause,first_call_at,latest_call_at,lookback_days,
              group_title,summary,verdict,recommended_action,analysis_model,analysis_prompt_version,outcome_status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
             ON CONFLICT (customer_id,issue_category,issue_cause,first_call_at,latest_call_at)
             DO UPDATE SET lookback_days=EXCLUDED.lookback_days,group_title=EXCLUDED.group_title,
             summary=EXCLUDED.summary,verdict=EXCLUDED.verdict,recommended_action=EXCLUDED.recommended_action,
             analysis_model=EXCLUDED.analysis_model,analysis_prompt_version=EXCLUDED.analysis_prompt_version,
             outcome_status=EXCLUDED.outcome_status,
             updated_at=now() RETURNING id`,
            [data.customerId, review.issue_category, review.issue_cause, firstCallAt, latestCallAt, lookbackDays,
              review.group_title, review.summary, review.verdict, review.recommended_action, model, promptVersion,
              calls[calls.length - 1]!.resolution_status]
          );
          for (const [index, call] of calls.entries()) {
            await client.query(
              `INSERT INTO recurring_call_members (recurring_group_id,call_recording_id,sequence_number)
               VALUES ($1,$2,$3) ON CONFLICT (recurring_group_id,call_recording_id)
               DO UPDATE SET sequence_number=EXCLUDED.sequence_number`, [group.rows[0]!.id, call.call_id, index + 1]
            );
          }
          await client.query(
            `UPDATE call_recordings SET call_statuses=CASE WHEN 'RECURRING'=ANY(call_statuses)
               THEN call_statuses ELSE array_append(call_statuses,'RECURRING') END,updated_at=now()
             WHERE id=ANY($1::uuid[])`, [review.call_ids]
          );
        }
      }
      await client.query(
        `UPDATE recurrence_jobs SET status='COMPLETED',last_error=NULL,completed_at=now(),updated_at=now()
         WHERE batch_id=$1 AND customer_id=$2`, [data.batchId, data.customerId]
      );
      await client.query(
        `UPDATE call_recordings SET recurrence_status='COMPLETED',recurrence_failure_reason=NULL,
         recurrence_completed_at=now(),updated_at=now()
         WHERE batch_id=$1 AND customer_id=$2 AND analysis_status='COMPLETED'`, [data.batchId, data.customerId]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async markFailed(data: RecurrenceJobData, reason: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE recurrence_jobs SET status='FAILED',last_error=$3,completed_at=now(),updated_at=now()
         WHERE batch_id=$1 AND customer_id=$2`, [data.batchId, data.customerId, reason]
      );
      await client.query(
        `UPDATE call_recordings SET recurrence_status='FAILED',recurrence_failure_reason=$3,
         recurrence_completed_at=now(),updated_at=now()
         WHERE batch_id=$1 AND customer_id=$2 AND analysis_status='COMPLETED'`,
        [data.batchId, data.customerId, reason]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Returns true only the first time this batch's state is computed to be
   * terminal (COMPLETED/COMPLETED_WITH_FAILURES) — the WHERE guard means the
   * UPDATE (and RETURNING) is skipped entirely once a batch is already in a
   * terminal state, so repeat calls from the various pipeline-stage hooks
   * that call this don't re-report a "just finished" signal every time.
   */
  async refreshBatchState(batchId: string): Promise<boolean> {
    const result = await this.pool.query<{ processing_state: string }>(
      `UPDATE upload_batches b SET processing_state=CASE
         WHEN EXISTS (SELECT 1 FROM call_recordings c WHERE c.batch_id=b.id
           AND c.transcription_status IN ('PENDING','QUEUED','TRANSCRIBING')) THEN 'TRANSCRIBING'
         WHEN EXISTS (SELECT 1 FROM call_recordings c WHERE c.batch_id=b.id AND c.transcription_status='COMPLETED'
           AND c.analysis_status IN ('PENDING','QUEUED','ANALYZING')) THEN 'ANALYZING'
         WHEN EXISTS (SELECT 1 FROM call_recordings c WHERE c.batch_id=b.id AND c.analysis_status='COMPLETED'
           AND c.recurrence_status IN ('PENDING','QUEUED','LINKING')) THEN 'LINKING_RECURRING_CALLS'
         WHEN EXISTS (SELECT 1 FROM call_recordings c WHERE c.batch_id=b.id AND
           (c.transcription_status='FAILED' OR c.analysis_status='FAILED' OR c.recurrence_status='FAILED'))
           THEN 'COMPLETED_WITH_FAILURES'
         ELSE 'COMPLETED' END,
       completed_at=CASE WHEN EXISTS (SELECT 1 FROM call_recordings c WHERE c.batch_id=b.id AND
         (c.transcription_status IN ('PENDING','QUEUED','TRANSCRIBING') OR
          (c.transcription_status='COMPLETED' AND c.analysis_status IN ('PENDING','QUEUED','ANALYZING')) OR
          (c.analysis_status='COMPLETED' AND c.recurrence_status IN ('PENDING','QUEUED','LINKING'))))
         THEN NULL ELSE now() END,updated_at=now()
       WHERE b.id=$1 AND b.ingestion_state IN ('COMPLETED','PARTIAL')
         AND b.processing_state NOT IN ('COMPLETED','COMPLETED_WITH_FAILURES')
       RETURNING processing_state`, [batchId]
    );
    const newState = result.rows[0]?.processing_state;
    return newState === 'COMPLETED' || newState === 'COMPLETED_WITH_FAILURES';
  }
}
