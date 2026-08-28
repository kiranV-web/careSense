import type pg from 'pg';

export interface RecordingForTranscription {
  id: string;
  batch_id: string;
  object_key: string;
  original_filename: string;
  language: string;
  agent_name: string | null;
  customer_name: string | null;
  channel_layout: 'STEREO' | 'MONO' | 'UNKNOWN';
  customer_channel: 'LEFT' | 'RIGHT' | null;
  agent_channel: 'LEFT' | 'RIGHT' | null;
}

export interface StoredSegment {
  segment_index: number;
  provider_speaker_label: string;
  speaker_role: 'AGENT' | 'CUSTOMER';
  speaker_name: string;
  start_seconds: number;
  end_seconds: number;
  text: string;
}

export class TranscriptionRepository {
  constructor(private readonly pool: pg.Pool) {}

  async pendingOutbox(limit = 100): Promise<Array<{ call_recording_id: string }>> {
    const result = await this.pool.query<{ call_recording_id: string }>(
      `SELECT call_recording_id FROM transcription_outbox WHERE status='PENDING'
       ORDER BY created_at LIMIT $1`, [limit]
    );
    return result.rows;
  }

  async markDispatched(callRecordingId: string): Promise<void> {
    await this.pool.query(
      `UPDATE transcription_outbox SET status='DISPATCHED',dispatched_at=now(),updated_at=now(),last_error=NULL
       WHERE call_recording_id=$1`, [callRecordingId]
    );
    await this.pool.query(
      `UPDATE call_recordings SET transcription_status='QUEUED',updated_at=now()
       WHERE id=$1 AND transcription_status='PENDING'`, [callRecordingId]
    );
  }

  async markDispatchError(callRecordingId: string, message: string): Promise<void> {
    await this.pool.query(
      `UPDATE transcription_outbox SET attempt_count=attempt_count+1,last_error=$2,updated_at=now()
       WHERE call_recording_id=$1`, [callRecordingId, message]
    );
  }

  async getRecording(callRecordingId: string): Promise<RecordingForTranscription | undefined> {
    const result = await this.pool.query<RecordingForTranscription>(
      `SELECT c.id,c.batch_id,c.object_key,c.original_filename,c.language,c.channel_layout,
       c.customer_channel,c.agent_channel,
       a.name AS agent_name,cu.name AS customer_name
       FROM call_recordings c JOIN agents a ON a.id=c.agent_id JOIN customers cu ON cu.id=c.customer_id
       WHERE c.id=$1`, [callRecordingId]
    );
    return result.rows[0];
  }

  async markTranscribing(callRecordingId: string, model: string, version: string, attempt: number): Promise<void> {
    await this.pool.query(
      `UPDATE call_recordings SET transcription_status='TRANSCRIBING',transcription_attempts=$2,
       transcription_model=$3,transcription_version=$4,transcription_failure_reason=NULL,
       transcription_started_at=COALESCE(transcription_started_at,now()),updated_at=now() WHERE id=$1`,
      [callRecordingId, attempt, model, version]
    );
  }

  async saveTranscript(callRecordingId: string, fullText: string, language: string | undefined,
    durationSeconds: number | undefined, rawResponse: unknown, segments: StoredSegment[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const state = await client.query<{ processing_state: string }>(
        `SELECT b.processing_state FROM upload_batches b JOIN call_recordings c ON c.batch_id=b.id
         WHERE c.id=$1 FOR SHARE OF b`, [callRecordingId]
      );
      if (!state.rows[0] || state.rows[0].processing_state === 'CANCELLED') {
        await client.query('ROLLBACK');
        return;
      }
      const transcript = await client.query<{ id: string }>(
        `INSERT INTO transcripts
         (call_recording_id,full_text,language,duration_seconds,segment_count,raw_provider_response)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb)
         ON CONFLICT (call_recording_id) DO UPDATE SET full_text=EXCLUDED.full_text,language=EXCLUDED.language,
         duration_seconds=EXCLUDED.duration_seconds,segment_count=EXCLUDED.segment_count,
         raw_provider_response=EXCLUDED.raw_provider_response,updated_at=now() RETURNING id`,
        [callRecordingId, fullText, language ?? null, durationSeconds ?? null, segments.length, JSON.stringify(rawResponse)]
      );
      await client.query('DELETE FROM transcript_segments WHERE call_recording_id=$1', [callRecordingId]);
      for (const segment of segments) {
        await client.query(
          `INSERT INTO transcript_segments
           (transcript_id,call_recording_id,segment_index,provider_speaker_label,speaker_role,speaker_name,
            start_seconds,end_seconds,text) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [transcript.rows[0]!.id, callRecordingId, segment.segment_index, segment.provider_speaker_label,
            segment.speaker_role, segment.speaker_name, segment.start_seconds, segment.end_seconds, segment.text]
        );
      }
      await client.query(
        `UPDATE call_recordings SET transcription_status='COMPLETED',transcription_failure_reason=NULL,
         transcription_completed_at=now(),analysis_status='PENDING',analysis_failure_reason=NULL,updated_at=now() WHERE id=$1`, [callRecordingId]
      );
      await client.query(
        `INSERT INTO analysis_outbox (call_recording_id,status,analysis_group_id,ready_at,updated_at)
         VALUES ($1,'READY',NULL,now(),now())
         ON CONFLICT (call_recording_id) DO UPDATE SET status='READY',analysis_group_id=NULL,
         ready_at=now(),updated_at=now()`, [callRecordingId]
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async markFailed(callRecordingId: string, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE call_recordings SET transcription_status='FAILED',transcription_failure_reason=$2,
       transcription_completed_at=now(),updated_at=now() WHERE id=$1`, [callRecordingId, reason]
    );
  }

  async refreshBatchState(batchId: string): Promise<void> {
    await this.pool.query(
      `UPDATE upload_batches b SET processing_state=CASE
         WHEN EXISTS (SELECT 1 FROM call_recordings c WHERE c.batch_id=b.id AND c.transcription_status='TRANSCRIBING') THEN 'TRANSCRIBING'
         WHEN EXISTS (SELECT 1 FROM call_recordings c WHERE c.batch_id=b.id AND c.transcription_status IN ('PENDING','QUEUED')) THEN 'TRANSCRIBING'
         WHEN EXISTS (SELECT 1 FROM call_recordings c WHERE c.batch_id=b.id AND c.transcription_status='COMPLETED'
           AND c.analysis_status IN ('PENDING','QUEUED','ANALYZING')) THEN 'ANALYZING'
         WHEN EXISTS (SELECT 1 FROM call_recordings c WHERE c.batch_id=b.id
           AND (c.transcription_status='FAILED' OR c.analysis_status='FAILED')) THEN 'COMPLETED_WITH_FAILURES'
         ELSE 'COMPLETED' END,
       completed_at=CASE WHEN NOT EXISTS (
         SELECT 1 FROM call_recordings c WHERE c.batch_id=b.id
         AND (c.transcription_status IN ('PENDING','QUEUED','TRANSCRIBING') OR
           (c.transcription_status='COMPLETED' AND c.analysis_status IN ('PENDING','QUEUED','ANALYZING')))
       ) THEN now() ELSE completed_at END,updated_at=now() WHERE b.id=$1 AND b.ingestion_state IN ('COMPLETED','PARTIAL')`, [batchId]
    );
  }

  async getTranscript(callRecordingId: string): Promise<Record<string, unknown> | undefined> {
    const transcript = await this.pool.query(
      `SELECT c.id AS recording_id,c.external_call_id,t.id,t.call_recording_id,t.full_text,t.language,t.duration_seconds,
       t.segment_count,t.created_at,t.updated_at,
       c.transcription_status,c.transcription_failure_reason FROM call_recordings c
       LEFT JOIN transcripts t ON t.call_recording_id=c.id WHERE c.id::text=$1 OR c.external_call_id=$1`, [callRecordingId]
    );
    if (!transcript.rows[0]) return undefined;
    const recordingId = transcript.rows[0].recording_id as string;
    const segments = await this.pool.query(
      `SELECT id AS segment_id,segment_index,provider_speaker_label,speaker_role,speaker_name,
       start_seconds,end_seconds,text,textual_tone
       FROM transcript_segments WHERE call_recording_id=$1 ORDER BY segment_index`, [recordingId]
    );
    return { ...transcript.rows[0], segments: segments.rows };
  }
}
