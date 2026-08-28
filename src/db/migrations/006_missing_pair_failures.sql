ALTER TABLE failed_calls
  DROP CONSTRAINT IF EXISTS failed_calls_reason_check;

ALTER TABLE failed_calls
  ADD CONSTRAINT failed_calls_reason_check
  CHECK (failure_reason IN (
    'SIZE_EXCEEDED',
    'DUPLICATE_CALL',
    'UNSUPPORTED_FORMAT',
    'INVALID_METADATA',
    'UNSAFE_ARCHIVE_PATH',
    'MISSING_AUDIO',
    'MISSING_METADATA'
  ));
