import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';

const confirmationFlag = '--yes';
if (!process.argv.includes(confirmationFlag)) {
  throw new Error(`Database truncation requires confirmation. Run: npm run truncate:data -- ${confirmationFlag}`);
}

const config = loadConfig();
if (config.NODE_ENV === 'production') {
  throw new Error('truncate:data is disabled when NODE_ENV=production');
}

const operationalTables = [
  'recurring_call_members', 'recurring_call_groups', 'recurrence_jobs', 'manager_alerts',
  'analysis_group_members', 'analysis_groups', 'analysis_outbox', 'call_evaluations',
  'transcript_segments', 'transcripts', 'transcription_outbox', 'failed_calls',
  'batch_file_staging', 'call_recordings', 'customers', 'agents', 'upload_batches'
] as const;

const pool = createPool(config);
try {
  await pool.query(`TRUNCATE TABLE ${operationalTables.join(',')} RESTART IDENTITY CASCADE`);
  console.log(`PostgreSQL operational tables truncated: ${operationalTables.length}`);
  console.log('Application settings and migration history were preserved');
  console.log('Redis queues, local staging, and Cloudflare R2 objects were not changed');
} finally {
  await pool.end();
}
