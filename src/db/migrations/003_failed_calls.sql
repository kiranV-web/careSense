CREATE TABLE IF NOT EXISTS failed_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES upload_batches(id) ON DELETE CASCADE,
  external_call_id varchar(255),
  file_type varchar(20) NOT NULL,
  filename varchar(500) NOT NULL,
  failure_reason varchar(50) NOT NULL,
  file_size_bytes bigint NOT NULL,
  max_size_bytes bigint NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT failed_calls_file_type_check CHECK (file_type IN ('AUDIO', 'METADATA')),
  CONSTRAINT failed_calls_reason_check CHECK (failure_reason IN ('SIZE_EXCEEDED'))
);

CREATE INDEX IF NOT EXISTS idx_failed_calls_batch ON failed_calls(batch_id);
CREATE INDEX IF NOT EXISTS idx_failed_calls_reason ON failed_calls(failure_reason);
