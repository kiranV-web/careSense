ALTER TABLE agents ADD COLUMN IF NOT EXISTS speaker_ids_seen text[] NOT NULL DEFAULT '{}';

UPDATE agents
SET speaker_ids_seen = ARRAY(
  SELECT DISTINCT value FROM unnest(
    speaker_ids_seen || CASE WHEN raw_metadata->>'speaker_id' IS NULL THEN '{}'::text[]
      ELSE ARRAY[raw_metadata->>'speaker_id'] END
  ) value
);

WITH ranked AS (
  SELECT id,
    first_value(id) OVER (PARTITION BY trim(both '-' FROM regexp_replace(lower(btrim(name)), '[^a-z0-9]+', '-', 'g'))
      ORDER BY created_at,id) AS canonical_id,
    row_number() OVER (PARTITION BY trim(both '-' FROM regexp_replace(lower(btrim(name)), '[^a-z0-9]+', '-', 'g'))
      ORDER BY created_at,id) AS position
  FROM agents WHERE name IS NOT NULL AND btrim(name)<>''
), duplicates AS (SELECT id,canonical_id FROM ranked WHERE position>1)
UPDATE call_recordings c SET agent_id=d.canonical_id FROM duplicates d WHERE c.agent_id=d.id;

WITH ranked AS (
  SELECT id,row_number() OVER (PARTITION BY trim(both '-' FROM regexp_replace(lower(btrim(name)), '[^a-z0-9]+', '-', 'g'))
    ORDER BY created_at,id) AS position
  FROM agents WHERE name IS NOT NULL AND btrim(name)<>''
)
DELETE FROM agents a USING ranked r WHERE a.id=r.id AND r.position>1;

UPDATE agents SET external_id=trim(both '-' FROM regexp_replace(lower(btrim(name)), '[^a-z0-9]+', '-', 'g'))
WHERE name IS NOT NULL AND btrim(name)<>'';

ALTER TABLE call_recordings ALTER COLUMN resolution_status TYPE varchar(50);
ALTER TABLE call_recordings ADD COLUMN IF NOT EXISTS customer_problem jsonb;
ALTER TABLE call_recordings ADD COLUMN IF NOT EXISTS quality_feedback text;

ALTER TABLE call_recordings DROP CONSTRAINT IF EXISTS call_recordings_resolution_status_check;
ALTER TABLE call_recordings ADD CONSTRAINT call_recordings_resolution_status_check CHECK (
  resolution_status IS NULL OR resolution_status IN
  ('RESOLVED','RESOLVED_BUT_IMPROVE_QUALITY','UNRESOLVED','DROPPED','ESCALATED','UNKNOWN')
);

ALTER TABLE recurring_call_groups DROP CONSTRAINT IF EXISTS recurring_call_groups_outcome_status_check;
ALTER TABLE recurring_call_groups ADD CONSTRAINT recurring_call_groups_outcome_status_check CHECK (
  outcome_status IN ('RESOLVED','RESOLVED_BUT_IMPROVE_QUALITY','UNRESOLVED','DROPPED','ESCALATED','UNKNOWN')
);

UPDATE transcript_segments SET textual_tone='NEUTRAL'
WHERE textual_tone IN ('WORRIED','CONFUSED');
ALTER TABLE transcript_segments DROP CONSTRAINT IF EXISTS transcript_segments_textual_tone_check;
ALTER TABLE transcript_segments ADD CONSTRAINT transcript_segments_textual_tone_check CHECK (
  textual_tone IS NULL OR textual_tone IN
  ('NEUTRAL','CALM','PLEASANT','IRRITATED','ANGRY','RUDE','HAPPY','SATISFIED','DISTRESSED','UNKNOWN')
);

UPDATE call_recordings SET
  resolution_status='RESOLVED_BUT_IMPROVE_QUALITY',
  quality_feedback='The agent should clearly confirm the appointment date and time before ending the call.',
  call_statuses=array_append(array_remove(call_statuses,'UNSOLVED'),'RESOLVED'),
  needs_manager_attention=false,updated_at=now()
WHERE id::text='9ee1002e-a962-4eda-8eac-16b8f2daf646'
   OR external_call_id='9ee1002e-a962-4eda-8eac-16b8f2daf646';

UPDATE transcript_segments SET textual_tone='NEUTRAL',updated_at=now()
WHERE call_recording_id IN (
  SELECT id FROM call_recordings WHERE id::text='58d0d1a0-74a1-4983-a47d-cfb8c8882058'
    OR external_call_id='58d0d1a0-74a1-4983-a47d-cfb8c8882058'
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
