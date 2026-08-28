-- Etiquette is not applicable once the agent has been classified as rude.
-- Remove legacy evaluations so reporting and agent quality scores exclude them.
DELETE FROM call_evaluations e
USING call_recordings c
WHERE e.call_recording_id = c.id
  AND 'RUDE' = ANY(c.call_statuses);
