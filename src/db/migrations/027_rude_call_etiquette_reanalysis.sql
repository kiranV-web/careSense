-- Rude calls are no longer skipped for etiquette evaluation (see analysis.ts):
-- showed_empathy is now forced to false for rude calls instead of leaving rules null.
-- Requeue the existing rude calls so they pick up real etiquette evaluations.
CREATE TEMP TABLE rude_call_reanalysis_calls ON COMMIT DROP AS
SELECT c.id,c.batch_id
FROM call_recordings c
JOIN upload_batches b ON b.id=c.batch_id
WHERE c.transcription_status='COMPLETED'
  AND 'RUDE'=ANY(c.call_statuses)
  AND b.processing_state<>'CANCELLED';

DELETE FROM recurring_call_groups g
WHERE EXISTS (
  SELECT 1 FROM recurring_call_members m
  JOIN rude_call_reanalysis_calls r ON r.id=m.call_recording_id
  WHERE m.recurring_group_id=g.id
);

DELETE FROM analysis_group_members gm
USING rude_call_reanalysis_calls r
WHERE gm.call_recording_id=r.id;

DELETE FROM analysis_groups g
WHERE NOT EXISTS (SELECT 1 FROM analysis_group_members gm WHERE gm.analysis_group_id=g.id);

DELETE FROM analysis_outbox o
USING rude_call_reanalysis_calls r
WHERE o.call_recording_id=r.id;

DELETE FROM call_evaluations e
USING rude_call_reanalysis_calls r
WHERE e.call_recording_id=r.id;

DELETE FROM manager_alerts a
USING rude_call_reanalysis_calls r
WHERE a.call_recording_id=r.id;

DELETE FROM recurrence_jobs j
WHERE j.batch_id IN (SELECT DISTINCT batch_id FROM rude_call_reanalysis_calls);

UPDATE transcript_segments s SET textual_tone=NULL,updated_at=now()
FROM rude_call_reanalysis_calls r
WHERE s.call_recording_id=r.id;

UPDATE call_recordings c SET
  analysis_status='PENDING',analysis_attempts=0,analysis_failure_reason=NULL,
  analysis_model=NULL,analysis_prompt_version=NULL,analysis_started_at=NULL,analysis_completed_at=NULL,
  title=NULL,short_description=NULL,issue_category=NULL,issue_cause=NULL,issue_summary=NULL,customer_problem=NULL,
  resolution_status=NULL,quality_feedback=NULL,call_statuses='{}',needs_manager_attention=NULL,urgency_level=NULL,
  recurrence_status='PENDING',recurrence_failure_reason=NULL,recurrence_completed_at=NULL,updated_at=now()
FROM rude_call_reanalysis_calls r
WHERE c.id=r.id;

INSERT INTO analysis_outbox(call_recording_id,status,analysis_group_id,ready_at,updated_at)
SELECT id,'READY',NULL,now(),now() FROM rude_call_reanalysis_calls
ON CONFLICT(call_recording_id) DO UPDATE SET
  status='READY',analysis_group_id=NULL,ready_at=now(),updated_at=now();

UPDATE upload_batches b SET processing_state='ANALYZING',completed_at=NULL,updated_at=now()
WHERE b.id IN (SELECT DISTINCT batch_id FROM rude_call_reanalysis_calls);
