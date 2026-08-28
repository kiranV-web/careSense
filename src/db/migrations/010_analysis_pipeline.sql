ALTER TABLE call_recordings
  ADD COLUMN IF NOT EXISTS analysis_status varchar(30) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS analysis_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS analysis_failure_reason text,
  ADD COLUMN IF NOT EXISTS analysis_model varchar(100),
  ADD COLUMN IF NOT EXISTS analysis_prompt_version varchar(50),
  ADD COLUMN IF NOT EXISTS analysis_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS analysis_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS title varchar(255),
  ADD COLUMN IF NOT EXISTS short_description text,
  ADD COLUMN IF NOT EXISTS issue_category varchar(50),
  ADD COLUMN IF NOT EXISTS issue_cause varchar(80),
  ADD COLUMN IF NOT EXISTS issue_summary text,
  ADD COLUMN IF NOT EXISTS resolution_status varchar(30),
  ADD COLUMN IF NOT EXISTS call_statuses text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS needs_manager_attention boolean,
  ADD COLUMN IF NOT EXISTS urgency_level varchar(20);

ALTER TABLE call_recordings
  DROP CONSTRAINT IF EXISTS call_recordings_analysis_status_check;
ALTER TABLE call_recordings
  ADD CONSTRAINT call_recordings_analysis_status_check
  CHECK (analysis_status IN ('PENDING','QUEUED','ANALYZING','COMPLETED','FAILED'));

ALTER TABLE call_recordings
  DROP CONSTRAINT IF EXISTS call_recordings_issue_category_check;
ALTER TABLE call_recordings
  ADD CONSTRAINT call_recordings_issue_category_check
  CHECK (issue_category IS NULL OR issue_category IN (
    'MOBILE_DATA','BATTERY_DRAIN','APP_PERMISSION','NOTIFICATIONS','DISPLAY',
    'WIFI','BLUETOOTH','KEYBOARD','EMERGENCY_SOS','OTHER'
  ));

ALTER TABLE call_recordings
  DROP CONSTRAINT IF EXISTS call_recordings_issue_cause_check;
ALTER TABLE call_recordings
  ADD CONSTRAINT call_recordings_issue_cause_check
  CHECK (issue_cause IS NULL OR issue_cause IN (
    'WRONG_PREFERRED_SIM','MOBILE_DATA_DISABLED','DATA_SAVER_ENABLED',
    'APP_NOTIFICATION_DISABLED','DO_NOT_DISTURB_ENABLED','EXTRA_DIM_ENABLED',
    'HIGH_SCREEN_RESOLUTION','HIGH_REFRESH_RATE','ALWAYS_ON_DISPLAY_ENABLED',
    'APP_PERMISSION_DENIED','WRONG_DEFAULT_APP','INTELLIGENT_WIFI_SWITCHING',
    'WRONG_KEYBOARD_LANGUAGE','EMERGENCY_SOS_SHORTCUT','UNKNOWN'
  ));

ALTER TABLE call_recordings
  DROP CONSTRAINT IF EXISTS call_recordings_resolution_status_check;
ALTER TABLE call_recordings
  ADD CONSTRAINT call_recordings_resolution_status_check
  CHECK (resolution_status IS NULL OR resolution_status IN ('RESOLVED','UNRESOLVED','DROPPED','ESCALATED','UNKNOWN'));

ALTER TABLE call_recordings
  DROP CONSTRAINT IF EXISTS call_recordings_urgency_level_check;
ALTER TABLE call_recordings
  ADD CONSTRAINT call_recordings_urgency_level_check
  CHECK (urgency_level IS NULL OR urgency_level IN ('LOW','MEDIUM','HIGH','CRITICAL'));

ALTER TABLE transcript_segments
  ADD COLUMN IF NOT EXISTS textual_tone varchar(30),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE transcript_segments
  DROP CONSTRAINT IF EXISTS transcript_segments_textual_tone_check;
ALTER TABLE transcript_segments
  ADD CONSTRAINT transcript_segments_textual_tone_check
  CHECK (textual_tone IS NULL OR textual_tone IN (
    'NEUTRAL','CALM','PLEASANT','WORRIED','CONFUSED','IRRITATED',
    'ANGRY','RUDE','HAPPY','SATISFIED','DISTRESSED','UNKNOWN'
  ));

CREATE TABLE IF NOT EXISTS call_evaluations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_recording_id uuid UNIQUE NOT NULL REFERENCES call_recordings(id) ON DELETE CASCADE,
  greeted_customer boolean NOT NULL,
  introduced_self boolean NOT NULL,
  showed_empathy boolean NOT NULL,
  offered_help boolean NOT NULL,
  provided_clear_guidance boolean NOT NULL,
  thanked_customer boolean NOT NULL,
  wished_customer_good_day boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS analysis_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  processing_state varchar(30) NOT NULL DEFAULT 'QUEUED',
  model varchar(100) NOT NULL,
  prompt_version varchar(50) NOT NULL,
  attempt_count integer NOT NULL DEFAULT 0,
  error_details jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT analysis_groups_state_check CHECK (processing_state IN ('QUEUED','ANALYZING','COMPLETED','FAILED','SPLIT'))
);

CREATE TABLE IF NOT EXISTS analysis_group_members (
  analysis_group_id uuid NOT NULL REFERENCES analysis_groups(id) ON DELETE CASCADE,
  call_recording_id uuid NOT NULL REFERENCES call_recordings(id) ON DELETE CASCADE,
  PRIMARY KEY (analysis_group_id, call_recording_id)
);

CREATE TABLE IF NOT EXISTS analysis_outbox (
  call_recording_id uuid PRIMARY KEY REFERENCES call_recordings(id) ON DELETE CASCADE,
  status varchar(20) NOT NULL DEFAULT 'READY',
  analysis_group_id uuid REFERENCES analysis_groups(id) ON DELETE SET NULL,
  ready_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT analysis_outbox_status_check CHECK (status IN ('READY','GROUPED'))
);

CREATE TABLE IF NOT EXISTS manager_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_recording_id uuid UNIQUE NOT NULL REFERENCES call_recordings(id) ON DELETE CASCADE,
  urgency_level varchar(20) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'OPEN',
  manager_notes text,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT manager_alerts_status_check CHECK (status IN ('OPEN','IN_REVIEW','CLOSED')),
  CONSTRAINT manager_alerts_urgency_check CHECK (urgency_level IN ('LOW','MEDIUM','HIGH','CRITICAL'))
);

CREATE INDEX IF NOT EXISTS idx_calls_analysis_status ON call_recordings(analysis_status);
CREATE INDEX IF NOT EXISTS idx_calls_manager_attention ON call_recordings(needs_manager_attention,urgency_level);
CREATE INDEX IF NOT EXISTS idx_calls_issue ON call_recordings(issue_category,issue_cause);
CREATE INDEX IF NOT EXISTS idx_calls_statuses ON call_recordings USING gin(call_statuses);
CREATE INDEX IF NOT EXISTS idx_analysis_outbox_ready ON analysis_outbox(status,ready_at);
CREATE INDEX IF NOT EXISTS idx_analysis_members_call ON analysis_group_members(call_recording_id);

-- Existing Phase 2 transcripts become eligible for analysis when this migration is first applied.
INSERT INTO analysis_outbox (call_recording_id)
SELECT c.id FROM call_recordings c
JOIN transcripts t ON t.call_recording_id=c.id
WHERE c.transcription_status='COMPLETED' AND c.analysis_status='PENDING'
ON CONFLICT (call_recording_id) DO NOTHING;
