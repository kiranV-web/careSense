ALTER TABLE recurring_call_groups
  ADD COLUMN IF NOT EXISTS outcome_status varchar(30) NOT NULL DEFAULT 'UNKNOWN';

ALTER TABLE recurring_call_groups
  DROP CONSTRAINT IF EXISTS recurring_call_groups_outcome_status_check;
ALTER TABLE recurring_call_groups
  ADD CONSTRAINT recurring_call_groups_outcome_status_check
  CHECK (outcome_status IN ('RESOLVED','UNRESOLVED','DROPPED','ESCALATED','UNKNOWN'));

UPDATE recurring_call_groups g
SET outcome_status=coalesce((
  SELECT c.resolution_status FROM recurring_call_members m
  JOIN call_recordings c ON c.id=m.call_recording_id
  WHERE m.recurring_group_id=g.id ORDER BY m.sequence_number DESC LIMIT 1
),'UNKNOWN'),updated_at=now();
