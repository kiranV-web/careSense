import path from 'node:path';
import type { Config } from '../config.js';
import type { Repository } from '../db/repository.js';
import { fingerprintZipEntry, inspectArchive, withZipEntry, type StagingItem } from './archive.js';
import type { ObjectStorage } from './storage.js';

function databaseErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
}

export async function ingestArchive(batchId: string, archivePath: string, config: Config,
  repository: Repository, storage: ObjectStorage): Promise<void> {
  try {
    if (await repository.isBatchCancelled(batchId)) return;
    const inspection = await inspectArchive(archivePath, config.MAX_ARCHIVE_ENTRIES, config.MAX_INGEST_FILE_BYTES,
      config.MAX_EXTRACTED_BYTES, config.DEFAULT_CALL_LANGUAGE);
    const items = inspection.items;
    const totalCalls = items.filter((item) => item.status !== 'UNSUPPORTED_FILE').length;
    await repository.setBatchInventory(batchId, inspection.totalEntries, totalCalls);
    let uploaded = 0;
    let paired = 0;
    let invalid = 0;

    for (const item of items) {
      if (await repository.isBatchCancelled(batchId)) return;
      if (item.status !== 'PAIRED' || !item.audio || !item.parsedMetadata) {
        // A stray unsupported file is recorded, but it is not a call and must
        // not make call-level progress exceed total_calls.
        const isIgnoredFile = item.status === 'UNSUPPORTED_FILE';
        if (!isIgnoredFile) invalid += 1;
        await repository.recordStaging(batchId, item);
        if (item.status === 'FILE_TOO_LARGE') {
          await repository.recordFailedCall(batchId, item, config.MAX_INGEST_FILE_BYTES);
        } else if (item.status === 'UNSUPPORTED_FILE' || item.status === 'INVALID_METADATA') {
          await repository.recordRejectedFile(batchId, item);
        } else if (item.status === 'MISSING_AUDIO' || item.status === 'MISSING_METADATA') {
          await repository.recordMissingPair(batchId, item);
        }
        await repository.updateIngestionCounts(batchId, uploaded, invalid);
        continue;
      }
      paired += 1;
      const extension = path.posix.extname(item.audio.fileName).toLowerCase();
      const key = `call-recordings/${batchId}/${encodeURIComponent(item.parsedMetadata.call_id)}/original${extension}`;
      let objectKey: string | undefined;
      let fingerprint: { checksum: string; bytes: number } | undefined;
      try {
        fingerprint = await fingerprintZipEntry(archivePath, item.audio.fileName);
        const existing = await repository.findRecordingByChecksum(fingerprint.checksum);
        if (existing) {
          invalid += 1;
          await repository.recordStaging(batchId, {
            ...item,
            status: 'DUPLICATE_RECORDING',
            errors: [`Audio content already exists as call ${existing.external_call_id}`]
          });
          await repository.recordDuplicateCall(batchId, item, fingerprint.checksum, fingerprint.bytes,
            existing.external_call_id);
          await repository.updateIngestionCounts(batchId, uploaded, invalid);
          continue;
        }
        const stored = await withZipEntry(archivePath, item.audio.fileName, (stream) =>
          storage.upload(key, stream, extension === '.mp3' ? 'audio/mpeg' : 'audio/wav'));
        if (await repository.isBatchCancelled(batchId)) {
          await storage.remove(stored.key).catch(() => undefined);
          return;
        }
        if (stored.checksum !== fingerprint.checksum || stored.bytes !== fingerprint.bytes) {
          throw new Error('Audio changed while it was being uploaded');
        }
        objectKey = stored.key;
        await repository.saveRecording(batchId, item.parsedMetadata, path.posix.basename(item.audio.fileName), extension.slice(1), stored);
        uploaded += 1;
        await repository.updateIngestionCounts(batchId, uploaded, invalid);
      } catch (error) {
        if (objectKey) await storage.remove(objectKey).catch(() => undefined);
        invalid += 1;
        const duplicate = databaseErrorCode(error) === '23505';
        const constraint = typeof error === 'object' && error !== null && 'constraint' in error ? String(error.constraint) : '';
        const failed: StagingItem = {
          ...item,
          status: duplicate && constraint === 'uq_call_recordings_audio_checksum'
            ? 'DUPLICATE_RECORDING'
            : duplicate ? 'DUPLICATE_CALL_ID' : 'UPLOAD_FAILED',
          errors: [error instanceof Error ? error.message : 'Failed to ingest recording']
        };
        await repository.recordStaging(batchId, failed);
        if (failed.status === 'DUPLICATE_RECORDING' && fingerprint) {
          const existing = await repository.findRecordingByChecksum(fingerprint.checksum);
          await repository.recordDuplicateCall(batchId, item, fingerprint.checksum, fingerprint.bytes,
            existing?.external_call_id ?? 'UNKNOWN');
        }
        await repository.updateIngestionCounts(batchId, uploaded, invalid);
      }
    }
    if (!await repository.isBatchCancelled(batchId)) {
      await repository.completeBatch(batchId, inspection.totalEntries, paired, invalid, uploaded);
    }
  } catch (error) {
    if (!await repository.isBatchCancelled(batchId)) {
      await repository.failBatch(batchId, error instanceof Error ? error.message : 'Archive processing failed');
    }
  }
}
