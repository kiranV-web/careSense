import type pg from 'pg';
import type { CallMetadata } from '../domain/metadata.js';
import type { StagingItem } from '../services/archive.js';
import type { StoredObject } from '../services/storage.js';

export class Repository {
  constructor(private readonly pool: pg.Pool, private readonly retentionDays: number) {}

  async createBatch(filename: string): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      'INSERT INTO upload_batches (original_filename) VALUES ($1) RETURNING id', [filename]
    );
    return result.rows[0]!.id;
  }

  async markProcessing(batchId: string, uploadBytes: number): Promise<void> {
    await this.pool.query(
      `UPDATE upload_batches SET upload_bytes=$2, processing_state='UPLOADED', ingestion_state='QUEUED', updated_at=now()
       WHERE id=$1 AND processing_state<>'CANCELLED'`,
      [batchId, uploadBytes]
    );
  }

  async isBatchCancelled(batchId: string): Promise<boolean> {
    const result = await this.pool.query<{ cancelled: boolean }>(
      `SELECT processing_state='CANCELLED' AS cancelled FROM upload_batches WHERE id=$1`, [batchId]
    );
    return result.rows[0]?.cancelled ?? true;
  }

  async cancelBatch(batchId: string): Promise<{
    cancelled: boolean; callRecordingIds: string[]; analysisGroupIds: string[]; customerIds: string[]
  } | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const batch = await client.query<{ processing_state: string }>(
        'SELECT processing_state FROM upload_batches WHERE id=$1 FOR UPDATE', [batchId]
      );
      if (!batch.rows[0]) { await client.query('ROLLBACK'); return undefined; }
      if (['COMPLETED','COMPLETED_WITH_FAILURES','FAILED','CANCELLED'].includes(batch.rows[0].processing_state)) {
        await client.query('COMMIT');
        return { cancelled: batch.rows[0].processing_state === 'CANCELLED', callRecordingIds: [], analysisGroupIds: [], customerIds: [] };
      }
      const calls = await client.query<{ id: string; customer_id: string }>(
        'SELECT id,customer_id FROM call_recordings WHERE batch_id=$1', [batchId]
      );
      const callRecordingIds = calls.rows.map((row) => row.id);
      const customerIds = [...new Set(calls.rows.map((row) => row.customer_id))];
      const affectedAnalysisGroupIds = callRecordingIds.length === 0 ? [] : (await client.query<{ analysis_group_id: string }>(
        'SELECT DISTINCT analysis_group_id FROM analysis_group_members WHERE call_recording_id=ANY($1::uuid[])',
        [callRecordingIds]
      )).rows.map((row) => row.analysis_group_id);
      await client.query(
        `UPDATE upload_batches SET processing_state='CANCELLED',ingestion_state='CANCELLED',
         failure_reason='USER_CANCELLED',failure_details=$2::jsonb,completed_at=now(),updated_at=now() WHERE id=$1`,
        [batchId, JSON.stringify({ message: 'Processing cancelled by user' })]
      );
      if (callRecordingIds.length > 0) {
        await client.query('DELETE FROM transcription_outbox WHERE call_recording_id=ANY($1::uuid[])', [callRecordingIds]);
        await client.query('DELETE FROM analysis_outbox WHERE call_recording_id=ANY($1::uuid[])', [callRecordingIds]);
        await client.query('DELETE FROM analysis_group_members WHERE call_recording_id=ANY($1::uuid[])', [callRecordingIds]);
      }
      const analysisGroupIds = affectedAnalysisGroupIds.length === 0 ? [] : (await client.query<{ id: string }>(
        `SELECT g.id FROM analysis_groups g WHERE g.id=ANY($1::uuid[])
         AND NOT EXISTS (SELECT 1 FROM analysis_group_members gm WHERE gm.analysis_group_id=g.id)`,
        [affectedAnalysisGroupIds]
      )).rows.map((row) => row.id);
      if (analysisGroupIds.length > 0) await client.query('DELETE FROM analysis_groups WHERE id=ANY($1::uuid[])', [analysisGroupIds]);
      await client.query('DELETE FROM recurrence_jobs WHERE batch_id=$1', [batchId]);
      await client.query('COMMIT');
      return { cancelled: true, callRecordingIds, analysisGroupIds, customerIds };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async setBatchInventory(batchId: string, totalEntries: number, totalCalls: number): Promise<void> {
    await this.pool.query(
      `UPDATE upload_batches SET total_entries=$2,total_calls=$3,processing_state='INGESTING',
       ingestion_state='PROCESSING',updated_at=now() WHERE id=$1 AND processing_state<>'CANCELLED'`, [batchId, totalEntries, totalCalls]
    );
  }

  async updateIngestionCounts(batchId: string, uploadedCalls: number, invalidPairs: number): Promise<void> {
    await this.pool.query(
      `UPDATE upload_batches SET uploaded_calls=$2,invalid_pairs=$3,updated_at=now()
       WHERE id=$1 AND processing_state<>'CANCELLED'`,
      [batchId, uploadedCalls, invalidPairs]
    );
  }

  async recordStaging(batchId: string, item: StagingItem, overrideErrors?: unknown[]): Promise<void> {
    await this.pool.query(
      `INSERT INTO batch_file_staging
       (batch_id, base_filename, audio_filename, metadata_filename, pairing_status, validation_errors, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,now() + ($7 * interval '1 day'))`,
      [batchId, item.stem, item.audio?.fileName ?? null, item.metadata?.fileName ?? null,
        item.status, JSON.stringify(overrideErrors ?? item.errors), this.retentionDays]
    );
  }

  async findRecordingByChecksum(checksum: string): Promise<{ id: string; external_call_id: string } | undefined> {
    const result = await this.pool.query<{ id: string; external_call_id: string }>(
      'SELECT id, external_call_id FROM call_recordings WHERE audio_checksum=$1 LIMIT 1', [checksum]
    );
    return result.rows[0];
  }

  async recordFailedCall(batchId: string, item: StagingItem, maxSizeBytes: number): Promise<void> {
    const oversizedAudio = item.audio && item.audio.uncompressedSize > maxSizeBytes;
    const entry = oversizedAudio ? item.audio : item.metadata;
    if (!entry) throw new Error('Oversized staging item has no file entry');
    await this.pool.query(
      `INSERT INTO failed_calls
       (batch_id,external_call_id,file_type,filename,failure_reason,file_size_bytes,max_size_bytes,details)
       VALUES ($1,$2,$3,$4,'SIZE_EXCEEDED',$5,$6,$7::jsonb)`,
      [batchId, item.parsedMetadata?.call_id ?? null, oversizedAudio ? 'AUDIO' : 'METADATA',
        entry.fileName, entry.uncompressedSize, maxSizeBytes,
        JSON.stringify({ message: 'File size exceeds the configured ingestion limit' })]
    );
  }

  async recordDuplicateCall(batchId: string, item: StagingItem, checksum: string, bytes: number,
    duplicateOfExternalCallId: string): Promise<void> {
    if (!item.audio || !item.parsedMetadata) throw new Error('Duplicate call requires audio and parsed metadata');
    await this.pool.query(
      `INSERT INTO failed_calls
       (batch_id,external_call_id,file_type,filename,failure_reason,file_size_bytes,max_size_bytes,
        duplicate_of_external_call_id,audio_checksum,details)
       VALUES ($1,$2,'AUDIO',$3,'DUPLICATE_CALL',$4,NULL,$5,$6,$7::jsonb)`,
      [batchId, item.parsedMetadata.call_id, item.audio.fileName, bytes, duplicateOfExternalCallId,
        checksum, JSON.stringify({ message: 'Audio content duplicates an existing call recording' })]
    );
  }

  async recordRejectedFile(batchId: string, item: StagingItem): Promise<void> {
    const entry = item.metadata ?? item.rejectedFile;
    if (!entry) throw new Error('Rejected staging item has no file entry');
    const extension = entry.fileName.toLowerCase().split('.').pop() ?? '';
    const isMetadata = Boolean(item.metadata) || entry.fileName.toLowerCase().includes('_meta.');
    const isKnownAudioType = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'wma'].includes(extension);
    const fileType = isMetadata ? 'METADATA' : isKnownAudioType ? 'AUDIO' : 'UNSUPPORTED';
    const unsafePath = item.errors.some((error) => String(error).includes('Unsafe archive path'));
    const failureReason = item.status === 'INVALID_METADATA'
      ? 'INVALID_METADATA'
      : unsafePath ? 'UNSAFE_ARCHIVE_PATH' : 'UNSUPPORTED_FORMAT';
    await this.pool.query(
      `INSERT INTO failed_calls
       (batch_id,external_call_id,file_type,filename,failure_reason,file_size_bytes,max_size_bytes,details)
       VALUES ($1,$2,$3,$4,$5,$6,NULL,$7::jsonb)`,
      [batchId, item.parsedMetadata?.call_id ?? null, fileType, entry.fileName, failureReason,
        entry.uncompressedSize, JSON.stringify({ validation_errors: item.errors })]
    );
  }

  async recordMissingPair(batchId: string, item: StagingItem): Promise<void> {
    if (item.status !== 'MISSING_AUDIO' && item.status !== 'MISSING_METADATA') {
      throw new Error('Missing-pair failure has an invalid status');
    }
    const entry = item.audio ?? item.metadata;
    if (!entry) throw new Error('Missing-pair failure has no source file');
    await this.pool.query(
      `INSERT INTO failed_calls
       (batch_id,external_call_id,file_type,filename,failure_reason,file_size_bytes,max_size_bytes,details)
       VALUES ($1,$2,$3,$4,$5,$6,NULL,$7::jsonb)`,
      [batchId, item.parsedMetadata?.call_id ?? null, item.audio ? 'AUDIO' : 'METADATA',
        entry.fileName, item.status, entry.uncompressedSize,
        JSON.stringify({ validation_errors: item.errors })]
    );
  }

  async saveRecording(batchId: string, metadata: CallMetadata, originalFilename: string,
    audioFormat: string, stored: StoredObject): Promise<string> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const customer = await client.query<{ id: string }>(
        `INSERT INTO customers (external_id, name, raw_metadata)
         VALUES ($1,$2,$3::jsonb)
         ON CONFLICT (external_id) DO UPDATE SET
           name=COALESCE(EXCLUDED.name, customers.name), raw_metadata=EXCLUDED.raw_metadata, updated_at=now()
         RETURNING id`,
        [metadata.customer.external_id, metadata.customer.name ?? null, JSON.stringify(metadata.customer.raw_metadata)]
      );
      const agent = await client.query<{ id: string }>(
        `INSERT INTO agents (external_id, name, raw_metadata, speaker_ids_seen)
         VALUES ($1,$2,$3::jsonb,CASE WHEN $4::text IS NULL THEN '{}'::text[] ELSE ARRAY[$4::text] END)
         ON CONFLICT (external_id) DO UPDATE SET
           name=COALESCE(EXCLUDED.name, agents.name), raw_metadata=EXCLUDED.raw_metadata,
           speaker_ids_seen=(SELECT ARRAY(SELECT DISTINCT value FROM unnest(agents.speaker_ids_seen || EXCLUDED.speaker_ids_seen) value)),
           updated_at=now()
         RETURNING id`,
        [metadata.agent.external_id, metadata.agent.name ?? null, JSON.stringify(metadata.agent.raw_metadata),
          metadata.source_agent_speaker_id ?? null]
      );
      const recording = await client.query<{ id: string }>(
        `INSERT INTO call_recordings
         (external_call_id,batch_id,customer_id,agent_id,original_filename,audio_format,audio_checksum,
          audio_bytes,storage_bucket,object_key,recording_url,validation_status,language,device_model,started_at,raw_metadata,
          banking_product,channel_layout,customer_channel,agent_channel,source_caller_speaker_id,source_agent_speaker_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'NOT_DONE',$12,$13,$14,$15::jsonb,$16,$17,$18,$19,$20,$21)
         RETURNING id`,
        [metadata.call_id, batchId, customer.rows[0]!.id, agent.rows[0]!.id, originalFilename,
          audioFormat, stored.checksum, stored.bytes, stored.bucket, stored.key, stored.url,
          metadata.language, metadata.device_model ?? null, metadata.started_at, JSON.stringify(metadata.raw_metadata),
          metadata.banking_product ?? null, metadata.channel_layout ?? 'UNKNOWN', metadata.customer_channel ?? null,
          metadata.agent_channel ?? null, metadata.source_caller_speaker_id ?? null,
          metadata.source_agent_speaker_id ?? null]
      );
      await client.query(
        `INSERT INTO transcription_outbox (call_recording_id) VALUES ($1)
         ON CONFLICT (call_recording_id) DO NOTHING`, [recording.rows[0]!.id]
      );
      await client.query('COMMIT');
      return recording.rows[0]!.id;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async completeBatch(batchId: string, totalEntries: number, pairedCalls: number,
    invalidPairs: number, uploadedCalls: number): Promise<void> {
    const state = uploadedCalls === 0 && invalidPairs > 0 ? 'FAILED' : 'TRANSCRIBING';
    const ingestionState = uploadedCalls === 0 && invalidPairs > 0 ? 'FAILED' : invalidPairs > 0 ? 'PARTIAL' : 'COMPLETED';
    const failureReason = state === 'FAILED' ? 'ALL_CALLS_FAILED' : null;
    const failureDetails = state === 'FAILED'
      ? { message: 'The batch failed because no call recordings were accepted', invalid_pairs: invalidPairs, paired_calls: pairedCalls }
      : null;
    const completedAt = state === 'FAILED' ? new Date() : null;
    await this.pool.query(
      `UPDATE upload_batches SET processing_state=$2,total_entries=$3,paired_calls=$4,invalid_pairs=$5,
       uploaded_calls=$6,failure_reason=$7,failure_details=$8::jsonb,ingestion_state=$9,
       updated_at=now(),completed_at=$10 WHERE id=$1 AND processing_state<>'CANCELLED'`,
      [batchId, state, totalEntries, pairedCalls, invalidPairs, uploadedCalls,
        failureReason, failureDetails ? JSON.stringify(failureDetails) : null, ingestionState, completedAt]
    );
    if (uploadedCalls > 0) {
      await this.pool.query(
        `UPDATE upload_batches b SET processing_state=CASE
           WHEN EXISTS (SELECT 1 FROM call_recordings c WHERE c.batch_id=b.id
             AND c.transcription_status IN ('PENDING','QUEUED','TRANSCRIBING')) THEN 'TRANSCRIBING'
           WHEN EXISTS (SELECT 1 FROM call_recordings c WHERE c.batch_id=b.id AND c.transcription_status='FAILED')
             THEN 'COMPLETED_WITH_FAILURES'
           ELSE 'COMPLETED' END,
         completed_at=CASE WHEN EXISTS (SELECT 1 FROM call_recordings c WHERE c.batch_id=b.id
           AND c.transcription_status IN ('PENDING','QUEUED','TRANSCRIBING')) THEN NULL ELSE now() END,
         updated_at=now() WHERE b.id=$1 AND b.processing_state<>'CANCELLED'`, [batchId]
      );
    }
  }

  async failBatch(batchId: string, message: string): Promise<void> {
    await this.pool.query(
      `UPDATE upload_batches SET processing_state='FAILED',invalid_pairs=invalid_pairs+1,
       ingestion_state='FAILED',failure_reason='ARCHIVE_PROCESSING_FAILED',failure_details=$2::jsonb,
       updated_at=now(),completed_at=now()
       WHERE id=$1 AND processing_state<>'CANCELLED'`,
      [batchId, JSON.stringify({ message })]
    );
    await this.pool.query(
      `INSERT INTO batch_file_staging
       (batch_id,base_filename,pairing_status,validation_errors,expires_at)
       VALUES ($1,'archive','UNSUPPORTED_FILE',$2::jsonb,now() + ($3 * interval '1 day'))`,
      [batchId, JSON.stringify([message]), this.retentionDays]
    );
  }

  async getBatch(batchId: string): Promise<Record<string, unknown> | undefined> {
    const result = await this.pool.query(
      `SELECT id AS batch_id,original_filename,upload_bytes,processing_state,ingestion_state,total_entries,total_calls,paired_calls,
       invalid_pairs,uploaded_calls,
       (SELECT count(*)::integer FROM failed_calls WHERE failed_calls.batch_id=upload_batches.id) AS failed_calls,
       (SELECT count(*)::integer FROM batch_file_staging s WHERE s.batch_id=upload_batches.id
         AND s.pairing_status='UNSUPPORTED_FILE') AS ignored_files,
       (SELECT count(*)::integer FROM call_recordings c WHERE c.batch_id=upload_batches.id
         AND c.transcription_status IN ('PENDING','QUEUED')) AS transcription_queued,
       (SELECT count(*)::integer FROM call_recordings c WHERE c.batch_id=upload_batches.id
         AND c.transcription_status='TRANSCRIBING') AS transcription_active,
       (SELECT count(*)::integer FROM call_recordings c WHERE c.batch_id=upload_batches.id
         AND c.transcription_status='COMPLETED') AS transcription_completed,
       (SELECT count(*)::integer FROM call_recordings c WHERE c.batch_id=upload_batches.id
         AND c.transcription_status='FAILED') AS transcription_failed,
       (SELECT count(*)::integer FROM call_recordings c WHERE c.batch_id=upload_batches.id
         AND c.transcription_status='COMPLETED' AND c.analysis_status IN ('PENDING','QUEUED')) AS analysis_queued,
       (SELECT count(*)::integer FROM call_recordings c WHERE c.batch_id=upload_batches.id
         AND c.analysis_status='ANALYZING') AS analysis_active,
       (SELECT count(*)::integer FROM call_recordings c WHERE c.batch_id=upload_batches.id
         AND c.analysis_status='COMPLETED') AS analysis_completed,
       (SELECT count(*)::integer FROM call_recordings c WHERE c.batch_id=upload_batches.id
         AND c.analysis_status='FAILED') AS analysis_failed,
       (SELECT count(*)::integer FROM call_recordings c WHERE c.batch_id=upload_batches.id
         AND c.analysis_status='COMPLETED' AND c.recurrence_status IN ('PENDING','QUEUED')) AS recurrence_queued,
       (SELECT count(*)::integer FROM call_recordings c WHERE c.batch_id=upload_batches.id
         AND c.recurrence_status='LINKING') AS recurrence_active,
       (SELECT count(*)::integer FROM call_recordings c WHERE c.batch_id=upload_batches.id
         AND c.recurrence_status='COMPLETED') AS recurrence_completed,
       (SELECT count(*)::integer FROM call_recordings c WHERE c.batch_id=upload_batches.id
         AND c.recurrence_status='FAILED') AS recurrence_failed,
       failure_reason,failure_details,created_at,updated_at,completed_at FROM upload_batches WHERE id=$1`, [batchId]
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const totalCalls = Number(row.total_calls ?? 0);
    const uploaded = Number(row.uploaded_calls ?? 0);
    const invalid = Number(row.invalid_pairs ?? 0);
    const transcriptionCompleted = Number(row.transcription_completed ?? 0);
    const transcriptionFailed = Number(row.transcription_failed ?? 0);
    const analysisCompleted = Number(row.analysis_completed ?? 0);
    const analysisFailed = Number(row.analysis_failed ?? 0);
    const terminalAnalysis = analysisCompleted + analysisFailed;
    const recurrenceCompleted = Number(row.recurrence_completed ?? 0);
    const recurrenceFailed = Number(row.recurrence_failed ?? 0);
    const terminalRecurrence = recurrenceCompleted + recurrenceFailed;
    const progressUnits = invalid * 100 + uploaded * 10 +
      (transcriptionCompleted + transcriptionFailed) * 50 + (terminalAnalysis + transcriptionFailed) * 30 +
      (terminalRecurrence + analysisFailed + transcriptionFailed) * 10;
    const processingPercentage = totalCalls === 0 ? 0 : Math.min(100, Math.round(progressUnits / totalCalls));
    return {
      ...row,
      archive_entries: Number(row.total_entries ?? 0),
      ingestion: { processed: uploaded + invalid, uploaded, failed: invalid, total: totalCalls },
      transcription: {
        queued: Number(row.transcription_queued ?? 0),
        active: Number(row.transcription_active ?? 0),
        completed: transcriptionCompleted,
        failed: transcriptionFailed,
        total: totalCalls
      },
      analysis: {
        queued: Number(row.analysis_queued ?? 0),
        active: Number(row.analysis_active ?? 0),
        completed: analysisCompleted,
        failed: analysisFailed,
        total: totalCalls
      },
      textual_tone: { completed: analysisCompleted, failed: analysisFailed, total: totalCalls },
      recurrence: {
        queued: Number(row.recurrence_queued ?? 0),
        active: Number(row.recurrence_active ?? 0),
        completed: recurrenceCompleted,
        failed: recurrenceFailed,
        total: totalCalls
      },
      processing_percentage: processingPercentage
    };
  }

  async getStagingErrors(batchId: string): Promise<Record<string, unknown>[]> {
    const result = await this.pool.query(
      `SELECT id,base_filename,audio_filename,metadata_filename,pairing_status,validation_errors,created_at
       FROM batch_file_staging WHERE batch_id=$1 ORDER BY created_at,id`, [batchId]
    );
    return result.rows;
  }

  async getFailedCalls(batchId: string): Promise<Record<string, unknown>[]> {
    const result = await this.pool.query(
      `SELECT id,external_call_id,file_type,filename,failure_reason,file_size_bytes,max_size_bytes,
       duplicate_of_external_call_id,audio_checksum,details,created_at
       FROM failed_calls WHERE batch_id=$1 ORDER BY created_at,id`, [batchId]
    );
    return result.rows;
  }
}
