import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';

const batchId = process.argv.find((value) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value));
if (!batchId || !process.argv.includes('--yes')) {
  throw new Error('Run: npm run retry:failed-analysis -- <batch-uuid> --yes');
}

const config = loadConfig();
if (config.NODE_ENV === 'production') throw new Error('retry:failed-analysis is disabled when NODE_ENV=production');

const pool = createPool(config);
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const analysisQueue = new Queue('analysis', { connection: redis });
try {
  const client = await pool.connect();
  let failedCallIds: string[] = [];
  let oldJobs: Array<{ id: string; prompt_version: string }> = [];
  try {
    await client.query('BEGIN');
    const batch = await client.query<{ id: string }>('SELECT id FROM upload_batches WHERE id=$1 FOR UPDATE', [batchId]);
    if (!batch.rows[0]) throw new Error(`Batch not found: ${batchId}`);
    const failed = await client.query<{ id: string }>(
      `SELECT id FROM call_recordings WHERE batch_id=$1 AND analysis_status='FAILED' ORDER BY id FOR UPDATE`, [batchId]
    );
    failedCallIds = failed.rows.map((row) => row.id);
    if (failedCallIds.length === 0) {
      await client.query('ROLLBACK');
    } else {
      oldJobs = (await client.query<{ id: string; prompt_version: string }>(
        `SELECT DISTINCT g.id,g.prompt_version FROM analysis_groups g JOIN analysis_group_members gm ON gm.analysis_group_id=g.id
         WHERE gm.call_recording_id=ANY($1::uuid[])`, [failedCallIds]
      )).rows;
      const recurrenceGroups = (await client.query<{ recurring_group_id: string }>(
        `SELECT DISTINCT recurring_group_id FROM recurring_call_members WHERE call_recording_id=ANY($1::uuid[])`, [failedCallIds]
      )).rows.map((row) => row.recurring_group_id);
      if (recurrenceGroups.length > 0) {
        await client.query('DELETE FROM recurring_call_groups WHERE id=ANY($1::uuid[])', [recurrenceGroups]);
      }
      await client.query('DELETE FROM analysis_group_members WHERE call_recording_id=ANY($1::uuid[])', [failedCallIds]);
      if (oldJobs.length > 0) {
        await client.query(
          `DELETE FROM analysis_groups g WHERE g.id=ANY($1::uuid[])
           AND NOT EXISTS (SELECT 1 FROM analysis_group_members gm WHERE gm.analysis_group_id=g.id)`,
          [oldJobs.map((job) => job.id)]
        );
      }
      await client.query('DELETE FROM analysis_outbox WHERE call_recording_id=ANY($1::uuid[])', [failedCallIds]);
      await client.query('DELETE FROM call_evaluations WHERE call_recording_id=ANY($1::uuid[])', [failedCallIds]);
      await client.query('DELETE FROM manager_alerts WHERE call_recording_id=ANY($1::uuid[])', [failedCallIds]);
      await client.query('DELETE FROM recurrence_jobs WHERE batch_id=$1', [batchId]);
      await client.query('UPDATE transcript_segments SET textual_tone=NULL,updated_at=now() WHERE call_recording_id=ANY($1::uuid[])', [failedCallIds]);
      await client.query(
        `UPDATE call_recordings SET analysis_status='PENDING',analysis_attempts=0,analysis_failure_reason=NULL,
         analysis_model=NULL,analysis_prompt_version=NULL,analysis_started_at=NULL,analysis_completed_at=NULL,
         title=NULL,short_description=NULL,issue_category=NULL,issue_cause=NULL,issue_summary=NULL,customer_problem=NULL,
         resolution_status=NULL,quality_feedback=NULL,call_statuses='{}',needs_manager_attention=NULL,urgency_level=NULL,
         recurrence_status='PENDING',recurrence_failure_reason=NULL,recurrence_completed_at=NULL,updated_at=now()
         WHERE id=ANY($1::uuid[])`, [failedCallIds]
      );
      await client.query(
        `INSERT INTO analysis_outbox(call_recording_id,status,analysis_group_id,ready_at,updated_at)
         SELECT id,'READY',NULL,now(),now() FROM call_recordings WHERE id=ANY($1::uuid[])`, [failedCallIds]
      );
      await client.query(
        `UPDATE upload_batches SET processing_state='ANALYZING',completed_at=NULL,updated_at=now()
         WHERE id=$1 AND processing_state<>'CANCELLED'`, [batchId]
      );
      await client.query('COMMIT');
    }
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  for (const job of oldJobs) {
    const queued = await analysisQueue.getJob(`analyze-${job.id}-${job.prompt_version}`);
    if (queued) await queued.remove().catch(() => undefined);
  }
  console.log(`Failed analyses requeued: ${failedCallIds.length}`);
  console.log(`New prompt version: ${config.ANALYSIS_PROMPT_VERSION}`);
} finally {
  await analysisQueue.close();
  redis.disconnect();
  await pool.end();
}
