import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { Redis } from 'ioredis';
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';

const confirmationFlag = '--yes';
if (!process.argv.includes(confirmationFlag)) {
  throw new Error(`Full reset requires confirmation. Run: npm run flush:all -- ${confirmationFlag}`);
}

const config = loadConfig();
if (config.NODE_ENV === 'production') {
  throw new Error('flush:all is disabled when NODE_ENV=production');
}

const operationalTables = [
  'recurring_call_members', 'recurring_call_groups', 'recurrence_jobs', 'manager_alerts',
  'analysis_group_members', 'analysis_groups', 'analysis_outbox', 'call_evaluations',
  'transcript_segments', 'transcripts', 'transcription_outbox', 'failed_calls',
  'batch_file_staging', 'call_recordings', 'customers', 'agents', 'upload_batches'
] as const;

function safeLocalDirectory(value: string): string {
  const workspace = path.resolve(process.cwd());
  const directory = path.resolve(value);
  if (directory === workspace || !directory.startsWith(`${workspace}${path.sep}`)) {
    throw new Error(`Refusing to clear a directory outside the project: ${directory}`);
  }
  return directory;
}

async function clearLocalDirectory(value: string): Promise<void> {
  const directory = safeLocalDirectory(value);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true, mode: 0o700 });
}

async function clearR2Recordings(): Promise<number> {
  const client = new S3Client({
    region: 'auto',
    endpoint: config.R2_ENDPOINT ?? `https://${config.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    forcePathStyle: config.R2_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: config.R2_ACCESS_KEY_ID,
      secretAccessKey: config.R2_SECRET_ACCESS_KEY
    }
  });
  let continuationToken: string | undefined;
  let deleted = 0;
  try {
    do {
      const result = await client.send(new ListObjectsV2Command({
        Bucket: config.R2_BUCKET_NAME,
        Prefix: 'call-recordings/',
        ContinuationToken: continuationToken
      }));
      const objects = (result.Contents ?? []).flatMap((item) => item.Key ? [{ Key: item.Key }] : []);
      if (objects.length > 0) {
        await client.send(new DeleteObjectsCommand({
          Bucket: config.R2_BUCKET_NAME,
          Delete: { Objects: objects, Quiet: true }
        }));
        deleted += objects.length;
      }
      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken);
    return deleted;
  } finally {
    client.destroy();
  }
}

const pool = createPool(config);
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
try {
  // Clear remote objects before their database references are removed, so a failed R2 request can be retried safely.
  const deletedR2Objects = await clearR2Recordings();
  await pool.query(`TRUNCATE TABLE ${operationalTables.join(',')} RESTART IDENTITY CASCADE`);
  await redis.flushdb();
  await clearLocalDirectory(config.UPLOAD_TMP_DIR);
  await clearLocalDirectory(config.TRANSCRIPTION_TMP_DIR);

  console.log('CareSense reset completed');
  console.log(`PostgreSQL operational tables truncated: ${operationalTables.length}`);
  console.log('Redis keys and BullMQ queues: 0');
  console.log('Local upload and transcription staging: empty');
  console.log(`Cloudflare R2 call-recordings objects deleted: ${deletedR2Objects}`);
  console.log('Application settings and migration history were preserved');
} finally {
  redis.disconnect();
  await pool.end();
}
