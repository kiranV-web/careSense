import { rm } from 'node:fs/promises';
import { UnrecoverableError, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';
import { Repository } from '../db/repository.js';
import { TranscriptionRepository } from '../db/transcription.repository.js';
import { AnalysisRepository } from '../db/analysis.repository.js';
import { RecurrenceRepository } from '../db/recurrence.repository.js';
import { SettingsRepository } from '../db/settings.repository.js';
import { QueueService, type AnalysisJobData, type IngestionJobData, type RecurrenceJobData,
  type TranscriptionJobData } from '../queues/queue.service.js';
import { ingestArchive } from '../services/ingestion.js';
import { ObjectStorage } from '../services/storage.js';
import { TranscriptionContractError, TranscriptionService } from '../services/transcription.js';
import { AnalysisService } from '../services/analysis.js';
import { RecurrenceAnalysisService } from '../services/recurrence-analysis.js';

const config = loadConfig();
const pool = createPool(config);
const repository = new Repository(pool, config.STAGING_RETENTION_DAYS);
const transcriptionRepository = new TranscriptionRepository(pool);
const analysisRepository = new AnalysisRepository(pool);
const recurrenceRepository = new RecurrenceRepository(pool);
const settingsRepository = new SettingsRepository(pool);
const storage = new ObjectStorage(config);
const transcriptionService = new TranscriptionService(config, storage);
const analysisService = new AnalysisService(config);
const recurrenceAnalysisService = new RecurrenceAnalysisService(config);
const queues = new QueueService(config);
const ingestionConnection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const transcriptionConnection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const analysisConnection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const recurrenceConnection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });

const ingestionWorker = new Worker<IngestionJobData>('ingestion', async (job) => {
  try {
    if (await repository.isBatchCancelled(job.data.batchId)) return;
    await ingestArchive(job.data.batchId, job.data.archivePath, config, repository, storage);
  } finally {
    await rm(job.data.archivePath, { force: true }).catch(() => undefined);
  }
}, { connection: ingestionConnection, concurrency: 1 });

const transcriptionWorker = new Worker<TranscriptionJobData>('transcription', async (job: Job<TranscriptionJobData>) => {
  const recording = await transcriptionRepository.getRecording(job.data.callRecordingId);
  if (!recording) throw new Error(`Recording not found: ${job.data.callRecordingId}`);
  if (await repository.isBatchCancelled(recording.batch_id)) return;
  await transcriptionRepository.markTranscribing(recording.id, config.OPENAI_TRANSCRIPTION_MODEL,
    config.TRANSCRIPTION_MODEL_VERSION, job.attemptsMade + 1);
  let result;
  try {
    result = await transcriptionService.transcribe(recording);
  } catch (error) {
    if (error instanceof TranscriptionContractError) {
      await transcriptionRepository.markFailed(recording.id, error.code);
      await recurrenceRepository.prepareBatch(recording.batch_id);
      await recurrenceRepository.refreshBatchState(recording.batch_id);
      throw new UnrecoverableError(error.code);
    }
    throw error;
  }
  if (await repository.isBatchCancelled(recording.batch_id)) return;
  await transcriptionRepository.saveTranscript(recording.id, result.fullText, result.language ?? recording.language,
    result.durationSeconds, result.rawResponse, result.segments);
  await transcriptionRepository.refreshBatchState(recording.batch_id);
}, { connection: transcriptionConnection, concurrency: config.TRANSCRIPTION_CONCURRENCY });

const analysisWorker = new Worker<AnalysisJobData>('analysis', async (job: Job<AnalysisJobData>) => {
  const calls = await analysisRepository.getGroupInputs(job.data.analysisGroupId);
  if (calls.length === 0) return;
  await analysisRepository.markAnalyzing(job.data.analysisGroupId, job.attemptsMade + 1);
  const results = await analysisService.analyze(calls);
  const batchIds = await analysisRepository.saveResults(job.data.analysisGroupId, config.OPENAI_ANALYSIS_MODEL,
    config.ANALYSIS_PROMPT_VERSION, results);
  await Promise.all(batchIds.map(async (batchId) => {
    await recurrenceRepository.prepareBatch(batchId);
    await recurrenceRepository.refreshBatchState(batchId);
  }));
}, { connection: analysisConnection, concurrency: config.ANALYSIS_CONCURRENCY });

const recurrenceWorker = new Worker<RecurrenceJobData>('recurrence', async (job: Job<RecurrenceJobData>) => {
  if (await repository.isBatchCancelled(job.data.batchId)) return;
  await recurrenceRepository.markRunning(job.data, job.attemptsMade + 1);
  const settings = await settingsRepository.get();
  const candidates = await recurrenceRepository.getCustomerCandidates(job.data, settings.recurring_lookback_days);
  const groups = await recurrenceAnalysisService.analyze(candidates);
  if (await repository.isBatchCancelled(job.data.batchId)) return;
  await recurrenceRepository.saveCustomerReview(job.data, settings.recurring_lookback_days, candidates, groups,
    config.OPENAI_RECURRENCE_MODEL, config.RECURRENCE_PROMPT_VERSION);
  await recurrenceRepository.refreshBatchState(job.data.batchId);
}, { connection: recurrenceConnection, concurrency: config.RECURRENCE_CONCURRENCY });

transcriptionWorker.on('failed', async (job, error) => {
  if (!job) return;
  const attempts = job.opts.attempts ?? 1;
  if (job.attemptsMade < attempts) return;
  const recording = await transcriptionRepository.getRecording(job.data.callRecordingId).catch(() => undefined);
  if (!recording) return;
  if (await repository.isBatchCancelled(recording.batch_id)) return;
  const reason = error.message.slice(0, 1_000);
  await transcriptionRepository.markFailed(recording.id, reason);
  await recurrenceRepository.prepareBatch(recording.batch_id);
  await recurrenceRepository.refreshBatchState(recording.batch_id);
});

analysisWorker.on('failed', async (job, error) => {
  if (!job) return;
  const attempts = job.opts.attempts ?? 1;
  if (job.attemptsMade < attempts) return;
  const reason = error.message.slice(0, 1_000);
  const outcome = await analysisRepository.failOrSplitGroup(job.data.analysisGroupId, reason,
    config.OPENAI_ANALYSIS_MODEL, config.ANALYSIS_PROMPT_VERSION);
  await Promise.all(outcome.batchIds.map(async (batchId) => {
    await recurrenceRepository.prepareBatch(batchId);
    await recurrenceRepository.refreshBatchState(batchId);
  }));
});

recurrenceWorker.on('failed', async (job, error) => {
  if (!job) return;
  const attempts = job.opts.attempts ?? 1;
  if (job.attemptsMade < attempts) return;
  if (await repository.isBatchCancelled(job.data.batchId)) return;
  await recurrenceRepository.markFailed(job.data, error.message.slice(0, 1_000));
  await recurrenceRepository.refreshBatchState(job.data.batchId);
});

let dispatching = false;
async function dispatchOutbox(): Promise<void> {
  if (dispatching) return;
  dispatching = true;
  try {
    for (const row of await transcriptionRepository.pendingOutbox()) {
      try {
        await queues.enqueueTranscription(row.call_recording_id);
        await transcriptionRepository.markDispatched(row.call_recording_id);
      } catch (error) {
        await transcriptionRepository.markDispatchError(row.call_recording_id,
          error instanceof Error ? error.message : 'Unable to enqueue transcription');
      }
    }
    while (await analysisRepository.createReadyGroup(config.ANALYSIS_GROUP_SIZE,
      config.ANALYSIS_GROUP_MAX_WAIT_MS, config.OPENAI_ANALYSIS_MODEL, config.ANALYSIS_PROMPT_VERSION)) {
      // Claim all full/expired micro-batches before dispatching them.
    }
    for (const groupId of await analysisRepository.pendingGroups()) {
      await queues.enqueueAnalysis(groupId);
    }
    for (const recurrenceJob of await recurrenceRepository.pendingJobs()) {
      try {
        await queues.enqueueRecurrence(recurrenceJob);
        await recurrenceRepository.markDispatched(recurrenceJob);
      } catch (error) {
        await recurrenceRepository.markDispatchError(recurrenceJob,
          error instanceof Error ? error.message : 'Unable to enqueue recurrence');
      }
    }
  } finally {
    dispatching = false;
  }
}

const dispatcher = setInterval(() => void dispatchOutbox(), 500);
await queues.ready();
await dispatchOutbox();
console.log(`CareSense workers started; transcription concurrency=${config.TRANSCRIPTION_CONCURRENCY}; analysis concurrency=${config.ANALYSIS_CONCURRENCY}; recurrence concurrency=${config.RECURRENCE_CONCURRENCY}`);

let shutdownPromise: Promise<void> | undefined;
function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    clearInterval(dispatcher);
    await Promise.all([ingestionWorker.close(), transcriptionWorker.close(), analysisWorker.close(),
      recurrenceWorker.close(), queues.close()]);
    ingestionConnection.disconnect();
    transcriptionConnection.disconnect();
    analysisConnection.disconnect();
    recurrenceConnection.disconnect();
    await pool.end();
  })();
  return shutdownPromise;
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
