import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { loadConfig } from '../config.js';
import { createPool } from './pool.js';

const config = loadConfig();
const pool = createPool(config);
const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

async function relationExists(client: pg.PoolClient, name: string): Promise<boolean> {
  const result = await client.query<{ relation: string | null }>('SELECT to_regclass($1) AS relation', [`public.${name}`]);
  return result.rows[0]?.relation !== null;
}

async function columnExists(client: pg.PoolClient, table: string, column: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 AND column_name=$2`, [table, column]
  );
  return (result.rowCount ?? 0) > 0;
}

async function failureConstraintIncludes(client: pg.PoolClient, value: string): Promise<boolean> {
  const result = await client.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
     WHERE conrelid='public.failed_calls'::regclass AND conname='failed_calls_reason_check'`
  );
  return result.rows[0]?.definition.includes(value) ?? false;
}

async function bootstrapLegacyMigrations(client: pg.PoolClient, files: string[]): Promise<void> {
  const count = await client.query<{ count: string }>('SELECT count(*) FROM schema_migrations');
  if (Number(count.rows[0]?.count ?? 0) > 0 || !(await relationExists(client, 'upload_batches'))) return;

  const checks: Record<string, () => Promise<boolean>> = {
    '001_phase_one.sql': async () => true,
    '002_unique_audio_checksum.sql': () => relationExists(client, 'uq_call_recordings_audio_checksum'),
    '003_failed_calls.sql': () => relationExists(client, 'failed_calls'),
    '004_duplicate_failed_calls.sql': () => columnExists(client, 'failed_calls', 'duplicate_of_external_call_id'),
    '005_rejected_file_failures.sql': () => failureConstraintIncludes(client, 'UNSUPPORTED_FORMAT'),
    '006_missing_pair_failures.sql': () => failureConstraintIncludes(client, 'MISSING_AUDIO'),
    '007_batch_failure_reason.sql': () => columnExists(client, 'upload_batches', 'failure_reason')
  };
  for (const file of files) {
    if (checks[file] && await checks[file]()) {
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
    }
  }
}

const client = await pool.connect();
try {
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       filename text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`
  );
  const files = (await readdir(directory)).filter((file) => file.endsWith('.sql')).sort();
  await bootstrapLegacyMigrations(client, files);
  const appliedResult = await client.query<{ filename: string }>('SELECT filename FROM schema_migrations');
  const applied = new Set(appliedResult.rows.map((row) => row.filename));
  let appliedNow = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    await client.query('BEGIN');
    try {
      await client.query(await readFile(path.join(directory, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
      await client.query('COMMIT');
      appliedNow += 1;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
  console.log(`Applied ${appliedNow} new migration file(s); ${files.length} total tracked`);
} finally {
  client.release();
  await pool.end();
}
