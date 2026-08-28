-- Re-run previously analyzed calls through the AI recurrence-review stage.
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
