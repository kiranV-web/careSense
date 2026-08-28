ALTER TABLE recurring_call_groups
  DROP CONSTRAINT IF EXISTS recurring_groups_known_cause_check;

ALTER TABLE recurring_call_groups
  ADD COLUMN IF NOT EXISTS group_title text NOT NULL DEFAULT 'Recurring Issue',
  ADD COLUMN IF NOT EXISTS summary text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS verdict text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS recommended_action text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS analysis_model text,
  ADD COLUMN IF NOT EXISTS analysis_prompt_version text;

-- One call is represented by one grouped row in the call list.
CREATE UNIQUE INDEX IF NOT EXISTS uq_recurring_member_call
  ON recurring_call_members(call_recording_id);
