CREATE UNIQUE INDEX IF NOT EXISTS uq_call_recordings_audio_checksum
  ON call_recordings(audio_checksum);
