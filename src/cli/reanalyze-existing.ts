import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';

if (!process.argv.includes('--yes')) {
  throw new Error('Run: npm run reanalyze:existing -- --yes');
}

const config = loadConfig();
if (config.NODE_ENV === 'production') throw new Error('reanalyze:existing is disabled when NODE_ENV=production');

const pool = createPool(config);
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const analysisQueue = new Queue('analysis', { connection: redis });
const recurrenceQueue = new Queue('recurrence', { connection: redis });

try {
  await Promise.all([analysisQueue.obliterate({ force: true }), recurrenceQueue.obliterate({ force: true })]);
  const client = await pool.connect();
  let count = 0;
  try {
    await client.query('BEGIN');
    await client.query(
      `CREATE TEMP TABLE empathy_reanalysis_calls ON COMMIT DROP AS
       SELECT c.id,c.batch_id FROM call_recordings c JOIN upload_batches b ON b.id=c.batch_id
       WHERE c.transcription_status='COMPLETED' AND b.processing_state<>'CANCELLED'`
    );
    const countResult = await client.query<{ count: string }>('SELECT count(*) FROM empathy_reanalysis_calls');
    count = Number(countResult.rows[0]?.count ?? 0);
    await client.query(
      `DELETE FROM recurring_call_groups g WHERE EXISTS (
         SELECT 1 FROM recurring_call_members m JOIN empathy_reanalysis_calls r ON r.id=m.call_recording_id
         WHERE m.recurring_group_id=g.id)`
    );
    await client.query(
      `DELETE FROM analysis_group_members gm USING empathy_reanalysis_calls r WHERE gm.call_recording_id=r.id`
    );
    await client.query(
      `DELETE FROM analysis_groups g WHERE NOT EXISTS (
         SELECT 1 FROM analysis_group_members gm WHERE gm.analysis_group_id=g.id)`
    );
    await client.query(
      `DELETE FROM analysis_outbox o USING empathy_reanalysis_calls r WHERE o.call_recording_id=r.id`
    );
    await client.query(
      `DELETE FROM call_evaluations e USING empathy_reanalysis_calls r WHERE e.call_recording_id=r.id`
    );
    await client.query(
      `DELETE FROM manager_alerts a USING empathy_reanalysis_calls r WHERE a.call_recording_id=r.id`
    );
    await client.query(
      `DELETE FROM recurrence_jobs j WHERE j.batch_id IN (SELECT DISTINCT batch_id FROM empathy_reanalysis_calls)`
    );
    await client.query(
      `UPDATE transcript_segments s SET textual_tone=NULL,updated_at=now()
       FROM empathy_reanalysis_calls r WHERE s.call_recording_id=r.id`
    );
    await client.query(
      `UPDATE call_recordings c SET analysis_status='PENDING',analysis_attempts=0,analysis_failure_reason=NULL,
       analysis_model=NULL,analysis_prompt_version=NULL,analysis_started_at=NULL,analysis_completed_at=NULL,
       title=NULL,short_description=NULL,issue_category=NULL,issue_cause=NULL,issue_summary=NULL,customer_problem=NULL,
       resolution_status=NULL,quality_feedback=NULL,call_statuses='{}',needs_manager_attention=NULL,urgency_level=NULL,
       recurrence_status='PENDING',recurrence_failure_reason=NULL,recurrence_completed_at=NULL,updated_at=now()
       FROM empathy_reanalysis_calls r WHERE c.id=r.id`
    );
    await client.query(
      `INSERT INTO analysis_outbox(call_recording_id,status,analysis_group_id,ready_at,updated_at)
       SELECT id,'READY',NULL,now(),now() FROM empathy_reanalysis_calls
       ON CONFLICT(call_recording_id) DO UPDATE SET
         status='READY',analysis_group_id=NULL,ready_at=now(),updated_at=now()`
    );
    await client.query(
      `UPDATE upload_batches b SET processing_state='ANALYZING',completed_at=NULL,updated_at=now()
       WHERE b.id IN (SELECT DISTINCT batch_id FROM empathy_reanalysis_calls)`
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  console.log(`Existing transcribed calls queued for reanalysis: ${count}`);
  console.log(`Prompt version: ${config.ANALYSIS_PROMPT_VERSION}`);
} finally {
  await Promise.all([analysisQueue.close(), recurrenceQueue.close()]);
  redis.disconnect();
  await pool.end();
}
