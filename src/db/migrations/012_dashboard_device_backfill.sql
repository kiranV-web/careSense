-- Recover device models from the retained metadata and make the dashboard fallback explicit.
UPDATE call_recordings
SET device_model = COALESCE(
  NULLIF(btrim(device_model), ''),
  NULLIF(btrim(raw_metadata ->> 'device_model'), ''),
  NULLIF(btrim(raw_metadata #>> '{caller,metadata,device_model}'), ''),
  'GENERAL'
), updated_at = now()
WHERE device_model IS NULL OR btrim(device_model) = '';

CREATE INDEX IF NOT EXISTS idx_calls_started_at
  ON call_recordings(started_at);

CREATE INDEX IF NOT EXISTS idx_calls_started_device
  ON call_recordings(started_at, device_model);

CREATE INDEX IF NOT EXISTS idx_calls_resolution_started
  ON call_recordings(started_at, resolution_status);
