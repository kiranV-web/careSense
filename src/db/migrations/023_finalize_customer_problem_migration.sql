ALTER TABLE recurring_call_groups DROP CONSTRAINT IF EXISTS recurring_call_groups_outcome_status_check;
ALTER TABLE recurring_call_groups ADD CONSTRAINT recurring_call_groups_outcome_status_check CHECK (
  outcome_status IN ('RESOLVED','RESOLVED_BUT_IMPROVE_QUALITY','UNRESOLVED','DROPPED','ESCALATED','UNKNOWN')
);

DELETE FROM analysis_group_members WHERE call_recording_id IN (
  SELECT id FROM call_recordings WHERE id::text='58d0d1a0-74a1-4983-a47d-cfb8c8882058'
    OR external_call_id='58d0d1a0-74a1-4983-a47d-cfb8c8882058'
);
DELETE FROM analysis_outbox WHERE call_recording_id IN (
  SELECT id FROM call_recordings WHERE id::text='58d0d1a0-74a1-4983-a47d-cfb8c8882058'
    OR external_call_id='58d0d1a0-74a1-4983-a47d-cfb8c8882058'
);
UPDATE call_recordings SET analysis_status='PENDING',customer_problem=NULL,analysis_failure_reason=NULL,updated_at=now()
WHERE (id::text='58d0d1a0-74a1-4983-a47d-cfb8c8882058'
   OR external_call_id='58d0d1a0-74a1-4983-a47d-cfb8c8882058')
  AND transcription_status='COMPLETED';
INSERT INTO analysis_outbox(call_recording_id)
SELECT id FROM call_recordings WHERE (id::text='58d0d1a0-74a1-4983-a47d-cfb8c8882058'
  OR external_call_id='58d0d1a0-74a1-4983-a47d-cfb8c8882058') AND transcription_status='COMPLETED'
ON CONFLICT(call_recording_id) DO NOTHING;
