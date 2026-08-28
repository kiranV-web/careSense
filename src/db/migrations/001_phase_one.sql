CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS upload_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  original_filename varchar(255) NOT NULL,
  upload_bytes bigint NOT NULL DEFAULT 0,
  processing_state varchar(30) NOT NULL DEFAULT 'UPLOADING',
  total_entries integer NOT NULL DEFAULT 0,
  paired_calls integer NOT NULL DEFAULT 0,
  invalid_pairs integer NOT NULL DEFAULT 0,
  uploaded_calls integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id varchar(255) UNIQUE NOT NULL,
  name varchar(255),
  raw_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id varchar(255) UNIQUE NOT NULL,
  name varchar(255),
  raw_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS call_recordings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_call_id varchar(255) UNIQUE NOT NULL,
  batch_id uuid NOT NULL REFERENCES upload_batches(id),
  customer_id uuid NOT NULL REFERENCES customers(id),
  agent_id uuid NOT NULL REFERENCES agents(id),
  original_filename varchar(255) NOT NULL,
  audio_format varchar(10) NOT NULL,
  audio_checksum varchar(64) NOT NULL,
  audio_bytes bigint NOT NULL,
  storage_bucket varchar(255) NOT NULL,
  object_key text NOT NULL UNIQUE,
  recording_url text NOT NULL,
  validation_status varchar(30) NOT NULL DEFAULT 'NOT_DONE',
  language varchar(30) NOT NULL,
  device_model varchar(255),
  started_at timestamptz NOT NULL,
  raw_metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT call_recordings_validation_status_check
    CHECK (validation_status IN ('NOT_DONE', 'VALID', 'INVALID'))
);

CREATE TABLE IF NOT EXISTS batch_file_staging (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES upload_batches(id) ON DELETE CASCADE,
  base_filename varchar(500) NOT NULL,
  audio_filename varchar(500),
  metadata_filename varchar(500),
  pairing_status varchar(40) NOT NULL,
  validation_errors jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_staging_batch ON batch_file_staging(batch_id);
CREATE INDEX IF NOT EXISTS idx_staging_status ON batch_file_staging(pairing_status);
CREATE INDEX IF NOT EXISTS idx_recordings_batch ON call_recordings(batch_id);
CREATE INDEX IF NOT EXISTS idx_recordings_customer_started ON call_recordings(customer_id, started_at);
CREATE INDEX IF NOT EXISTS idx_recordings_agent_started ON call_recordings(agent_id, started_at);
