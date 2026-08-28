import { createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import Busboy from 'busboy';
import type { Request, Response } from 'express';
import type { Config } from '../config.js';
import type { Repository } from '../db/repository.js';
import type { QueueService } from '../queues/queue.service.js';

export function uploadHandler(config: Config, repository: Repository, queues: QueueService) {
  return async (request: Request, response: Response): Promise<void> => {
    if (!request.is('multipart/form-data')) {
      response.status(415).json({ error: 'Content-Type must be multipart/form-data' });
      return;
    }
    await mkdir(config.UPLOAD_TMP_DIR, { recursive: true, mode: 0o700 });
    let batchId: string | undefined;
    let archivePath: string | undefined;
    try {
      const busboy = Busboy({ headers: request.headers, limits: { files: 1, fileSize: config.MAX_UPLOAD_BYTES, fields: 0 } });
      const received = new Promise<{ path: string; batchId: string }>((resolve, reject) => {
        let task: Promise<void> | undefined;
        let seenArchive = false;
        busboy.on('file', (_field, stream, info) => {
          if (_field !== 'archive') { stream.resume(); return; }
          seenArchive = true;
          if (!info.filename.toLowerCase().endsWith('.zip')) { stream.resume(); reject(new Error('archive must be a .zip file')); return; }
          task = (async () => {
            batchId = await repository.createBatch(path.basename(info.filename));
            archivePath = path.resolve(config.UPLOAD_TMP_DIR, `${batchId}.zip`);
            await pipeline(stream, createWriteStream(archivePath, { mode: 0o600, flags: 'wx' }));
            if (stream.truncated) throw new Error(`Archive exceeds ${config.MAX_UPLOAD_BYTES} bytes`);
          })();
        });
        busboy.on('error', reject);
        busboy.on('finish', async () => {
          try {
            if (!seenArchive || !task) throw new Error('multipart field "archive" is required');
            await task;
            resolve({ path: archivePath!, batchId: batchId! });
          } catch (error) { reject(error); }
        });
      });
      request.pipe(busboy);
      const upload = await received;
      const details = await stat(upload.path);
      await repository.markProcessing(upload.batchId, details.size);
      await queues.enqueueIngestion({ batchId: upload.batchId, archivePath: upload.path });
      const result = await repository.getBatch(upload.batchId);
      response.status(202).json({
        ...result,
        status_url: `/api/v1/upload-batches/${upload.batchId}`,
        events_url: `/api/v1/upload-batches/${upload.batchId}/events`,
        staging_errors_url: `/api/v1/upload-batches/${upload.batchId}/staging-errors`,
        failed_calls_url: `/api/v1/upload-batches/${upload.batchId}/failed-calls`
      });
    } catch (error) {
      if (archivePath) await rm(archivePath, { force: true }).catch(() => undefined);
      if (batchId) await repository.failBatch(batchId, error instanceof Error ? error.message : 'Upload failed').catch(() => undefined);
      response.status(400).json({ error: error instanceof Error ? error.message : 'Upload failed', batch_id: batchId });
    }
  };
}
