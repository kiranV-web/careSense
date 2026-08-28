CREATE TABLE IF NOT EXISTS application_settings (
  id smallint PRIMARY KEY DEFAULT 1,
  recurring_lookback_days integer NOT NULL DEFAULT 10,
  ideal_call_duration_seconds integer NOT NULL DEFAULT 300,
  call_etiquette text[] NOT NULL DEFAULT ARRAY[
    'greeted_customer','introduced_self','showed_empathy','offered_help',
    'provided_clear_guidance','thanked_customer','wished_customer_good_day'
  ]::text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT application_settings_singleton_check CHECK (id = 1),
  CONSTRAINT application_settings_lookback_check CHECK (recurring_lookback_days BETWEEN 1 AND 365),
  CONSTRAINT application_settings_duration_check CHECK (ideal_call_duration_seconds BETWEEN 1 AND 86400),
  CONSTRAINT application_settings_etiquette_not_empty CHECK (cardinality(call_etiquette) > 0),
  CONSTRAINT application_settings_etiquette_known_check CHECK (call_etiquette <@ ARRAY[
    'greeted_customer','introduced_self','showed_empathy','offered_help',
    'provided_clear_guidance','thanked_customer','wished_customer_good_day'
  ]::text[])
);

INSERT INTO application_settings (id,recurring_lookback_days,ideal_call_duration_seconds)
VALUES (1,10,300)
ON CONFLICT (id) DO UPDATE SET recurring_lookback_days=10,updated_at=now();

-- Recalculate existing recurrence data under the new 10-day window.
DELETE FROM recurring_call_groups;

UPDATE call_recordings
SET call_statuses=array_remove(call_statuses,'RECURRING'),
    recurrence_status=CASE WHEN analysis_status='COMPLETED' THEN 'QUEUED' ELSE recurrence_status END,
    recurrence_failure_reason=NULL,
    recurrence_completed_at=CASE WHEN analysis_status='COMPLETED' THEN NULL ELSE recurrence_completed_at END,
    updated_at=now();

INSERT INTO recurrence_jobs (batch_id,customer_id,status)
SELECT DISTINCT batch_id,customer_id,'PENDING' FROM call_recordings WHERE analysis_status='COMPLETED'
ON CONFLICT (batch_id,customer_id) DO UPDATE
SET status='PENDING',attempt_count=0,last_error=NULL,dispatched_at=NULL,started_at=NULL,
    completed_at=NULL,updated_at=now();

UPDATE upload_batches b
SET processing_state='LINKING_RECURRING_CALLS',completed_at=NULL,updated_at=now()
WHERE EXISTS (
  SELECT 1 FROM call_recordings c
  WHERE c.batch_id=b.id AND c.analysis_status='COMPLETED' AND c.recurrence_status='QUEUED'
);
