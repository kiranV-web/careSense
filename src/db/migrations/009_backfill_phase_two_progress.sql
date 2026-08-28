-- Phase 1 batches predate total_calls and ingestion_state. Backfill them so the
-- Phase 2 progress API remains accurate for already-ingested recordings.
UPDATE upload_batches AS b
SET total_calls = GREATEST(
      b.total_calls,
      b.paired_calls,
      b.uploaded_calls + b.invalid_pairs,
      (SELECT count(*)::integer FROM call_recordings AS c WHERE c.batch_id = b.id)
    ),
    ingestion_state = CASE
      WHEN b.processing_state = 'FAILED' THEN 'FAILED'
      WHEN b.invalid_pairs > 0 AND b.uploaded_calls > 0 THEN 'PARTIAL'
      WHEN b.invalid_pairs > 0 AND b.uploaded_calls = 0 THEN 'FAILED'
      WHEN b.processing_state IN ('COMPLETED', 'COMPLETED_WITH_FAILURES') THEN 'COMPLETED'
      ELSE b.ingestion_state
    END,
    updated_at = now()
WHERE b.total_calls = 0 OR b.ingestion_state = 'PENDING';
