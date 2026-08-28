ALTER TABLE upload_batches DROP CONSTRAINT IF EXISTS upload_batches_failure_reason_check;
ALTER TABLE upload_batches ADD CONSTRAINT upload_batches_failure_reason_check CHECK (
  failure_reason IS NULL OR failure_reason IN
  ('ALL_CALLS_FAILED','ARCHIVE_PROCESSING_FAILED','UPLOAD_FAILED','USER_CANCELLED')
);
