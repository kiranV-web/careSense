ALTER TABLE call_recordings
  ADD COLUMN IF NOT EXISTS source_caller_speaker_id varchar(100),
  ADD COLUMN IF NOT EXISTS source_agent_speaker_id varchar(100);

CREATE INDEX IF NOT EXISTS idx_calls_source_caller_speaker
  ON call_recordings(source_caller_speaker_id, started_at);
