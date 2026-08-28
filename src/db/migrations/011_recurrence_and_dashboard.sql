ALTER TABLE call_recordings
  ADD COLUMN IF NOT EXISTS recurrence_status varchar(30) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS recurrence_failure_reason text,
  ADD COLUMN IF NOT EXISTS recurrence_completed_at timestamptz;

ALTER TABLE call_recordings
  DROP CONSTRAINT IF EXISTS call_recordings_recurrence_status_check;
ALTER TABLE call_recordings
  ADD CONSTRAINT call_recordings_recurrence_status_check
  CHECK (recurrence_status IN ('PENDING','QUEUED','LINKING','COMPLETED','FAILED'));

CREATE TABLE IF NOT EXISTS recurring_call_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  issue_category varchar(50) NOT NULL,
  issue_cause varchar(80) NOT NULL,
  first_call_at timestamptz NOT NULL,
  latest_call_at timestamptz NOT NULL,
  lookback_days integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recurring_groups_known_cause_check CHECK (issue_cause <> 'UNKNOWN'),
  UNIQUE (customer_id,issue_category,issue_cause,first_call_at,latest_call_at)
);

CREATE TABLE IF NOT EXISTS recurring_call_members (
  recurring_group_id uuid NOT NULL REFERENCES recurring_call_groups(id) ON DELETE CASCADE,
  call_recording_id uuid NOT NULL REFERENCES call_recordings(id) ON DELETE CASCADE,
  sequence_number integer NOT NULL,
  PRIMARY KEY (recurring_group_id,call_recording_id),
  UNIQUE (recurring_group_id,sequence_number)
);

CREATE TABLE IF NOT EXISTS recurrence_jobs (
  batch_id uuid NOT NULL REFERENCES upload_batches(id) ON DELETE CASCADE,
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  status varchar(20) NOT NULL DEFAULT 'PENDING',
  attempt_count integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id,customer_id),
  CONSTRAINT recurrence_jobs_status_check CHECK (status IN ('PENDING','DISPATCHED','RUNNING','COMPLETED','FAILED'))
);

CREATE INDEX IF NOT EXISTS idx_recurrence_jobs_pending ON recurrence_jobs(status,created_at);
CREATE INDEX IF NOT EXISTS idx_recurring_groups_customer ON recurring_call_groups(customer_id,latest_call_at DESC);
CREATE INDEX IF NOT EXISTS idx_recurring_members_call ON recurring_call_members(call_recording_id);
CREATE INDEX IF NOT EXISTS idx_calls_recurrence_status ON call_recordings(recurrence_status);

-- Finish Phase 3 data through the new deterministic recurrence stage.
INSERT INTO recurrence_jobs (batch_id,customer_id)
SELECT DISTINCT c.batch_id,c.customer_id
FROM call_recordings c
WHERE c.analysis_status='COMPLETED'
ON CONFLICT (batch_id,customer_id) DO NOTHING;

UPDATE call_recordings
SET recurrence_status='QUEUED',updated_at=now()
WHERE analysis_status='COMPLETED' AND recurrence_status='PENDING';

UPDATE upload_batches b
SET processing_state='LINKING_RECURRING_CALLS',completed_at=NULL,updated_at=now()
WHERE EXISTS (SELECT 1 FROM call_recordings c WHERE c.batch_id=b.id AND c.recurrence_status='QUEUED')
  AND b.ingestion_state IN ('COMPLETED','PARTIAL');
