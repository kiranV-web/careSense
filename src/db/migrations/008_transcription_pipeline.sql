ALTER TABLE upload_batches
  ADD COLUMN IF NOT EXISTS total_calls integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ingestion_state varchar(30) NOT NULL DEFAULT 'PENDING';

ALTER TABLE call_recordings
  ADD COLUMN IF NOT EXISTS transcription_status varchar(30) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS transcription_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS transcription_failure_reason text,
  ADD COLUMN IF NOT EXISTS transcription_model varchar(100),
  ADD COLUMN IF NOT EXISTS transcription_version varchar(50),
  ADD COLUMN IF NOT EXISTS transcription_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS transcription_completed_at timestamptz;

ALTER TABLE call_recordings
  DROP CONSTRAINT IF EXISTS call_recordings_transcription_status_check;

ALTER TABLE call_recordings
  ADD CONSTRAINT call_recordings_transcription_status_check
  CHECK (transcription_status IN ('PENDING','QUEUED','TRANSCRIBING','COMPLETED','FAILED'));

CREATE TABLE IF NOT EXISTS transcription_outbox (
  call_recording_id uuid PRIMARY KEY REFERENCES call_recordings(id) ON DELETE CASCADE,
  status varchar(20) NOT NULL DEFAULT 'PENDING',
  attempt_count integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transcription_outbox_status_check CHECK (status IN ('PENDING','DISPATCHED'))
);

CREATE TABLE IF NOT EXISTS transcripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_recording_id uuid UNIQUE NOT NULL REFERENCES call_recordings(id) ON DELETE CASCADE,
  full_text text NOT NULL,
  language varchar(30),
  duration_seconds numeric,
  segment_count integer NOT NULL,
  raw_provider_response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transcript_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transcript_id uuid NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
  call_recording_id uuid NOT NULL REFERENCES call_recordings(id) ON DELETE CASCADE,
  segment_index integer NOT NULL,
  provider_speaker_label varchar(100) NOT NULL,
  speaker_role varchar(20) NOT NULL,
  speaker_name varchar(255) NOT NULL,
  start_seconds numeric NOT NULL,
  end_seconds numeric NOT NULL,
  text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transcript_segments_role_check CHECK (speaker_role IN ('AGENT','CUSTOMER')),
  CONSTRAINT transcript_segments_time_check CHECK (end_seconds >= start_seconds),
  UNIQUE (call_recording_id, segment_index)
);

CREATE INDEX IF NOT EXISTS idx_calls_transcription_status ON call_recordings(transcription_status);
CREATE INDEX IF NOT EXISTS idx_segments_call_start ON transcript_segments(call_recording_id,start_seconds);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON transcription_outbox(status,created_at);
