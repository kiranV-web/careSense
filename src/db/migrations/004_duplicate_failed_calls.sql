ALTER TABLE failed_calls
  ALTER COLUMN max_size_bytes DROP NOT NULL;

ALTER TABLE failed_calls
  ADD COLUMN IF NOT EXISTS duplicate_of_external_call_id varchar(255),
  ADD COLUMN IF NOT EXISTS audio_checksum varchar(64);

ALTER TABLE failed_calls
  DROP CONSTRAINT IF EXISTS failed_calls_reason_check;

ALTER TABLE failed_calls
  ADD CONSTRAINT failed_calls_reason_check
  CHECK (failure_reason IN ('SIZE_EXCEEDED', 'DUPLICATE_CALL'));

CREATE INDEX IF NOT EXISTS idx_failed_calls_checksum ON failed_calls(audio_checksum);
