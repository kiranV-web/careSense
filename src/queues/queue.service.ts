import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { Config } from '../config.js';

export interface IngestionJobData { batchId: string; archivePath: string }
export interface TranscriptionJobData { callRecordingId: string }
export interface AnalysisJobData { analysisGroupId: string }
export interface RecurrenceJobData { batchId: string; customerId: string }

export class QueueService {
  readonly connection: Redis;
  readonly ingestion: Queue<IngestionJobData>;
  readonly transcription: Queue<TranscriptionJobData>;
  readonly analysis: Queue<AnalysisJobData>;
  readonly recurrence: Queue<RecurrenceJobData>;

  constructor(private readonly config: Config) {
    this.connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
    this.ingestion = new Queue<IngestionJobData>('ingestion', { connection: this.connection });
    this.transcription = new Queue<TranscriptionJobData>('transcription', { connection: this.connection });
    this.analysis = new Queue<AnalysisJobData>('analysis', { connection: this.connection });
    this.recurrence = new Queue<RecurrenceJobData>('recurrence', { connection: this.connection });
  }

  async ready(): Promise<void> {
    await Promise.all([this.ingestion.waitUntilReady(), this.transcription.waitUntilReady(),
      this.analysis.waitUntilReady(), this.recurrence.waitUntilReady()]);
    await this.connection.ping();
  }

  async enqueueIngestion(data: IngestionJobData): Promise<void> {
    await this.ingestion.add('VALIDATE_BATCH', data, {
      jobId: `ingest-${data.batchId}`,
      attempts: 2,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 100,
      removeOnFail: 500
    });
  }

  async enqueueTranscription(callRecordingId: string): Promise<void> {
    await this.transcription.add('TRANSCRIBE_CALL', { callRecordingId }, {
      jobId: `transcribe-${callRecordingId}-${this.config.TRANSCRIPTION_MODEL_VERSION}`,
      attempts: this.config.TRANSCRIPTION_MAX_ATTEMPTS,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 500,
      removeOnFail: 1_000
    });
  }

  async enqueueAnalysis(analysisGroupId: string): Promise<void> {
    await this.analysis.add('ANALYZE_CALL_GROUP', { analysisGroupId }, {
      jobId: `analyze-${analysisGroupId}-${this.config.ANALYSIS_PROMPT_VERSION}`,
      attempts: this.config.ANALYSIS_MAX_ATTEMPTS,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 500,
      removeOnFail: 1_000
    });
  }

  async enqueueRecurrence(data: RecurrenceJobData): Promise<void> {
    const jobId = `recurrence-${data.customerId}-${data.batchId}`;
    const existing = await this.recurrence.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'completed' || state === 'failed') await existing.remove();
      else return;
    }
    await this.recurrence.add('LINK_CUSTOMER_RECURRENCE', data, {
      jobId,
      attempts: this.config.RECURRENCE_MAX_ATTEMPTS,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 500,
      removeOnFail: 1_000
    });
  }

  async cancelBatch(batchId: string, callRecordingIds: string[], analysisGroupIds: string[], customerIds: string[]): Promise<void> {
    const remove = async (queue: Queue, jobId: string): Promise<void> => {
      const job = await queue.getJob(jobId);
      if (!job) return;
      await job.remove().catch(() => undefined); // Active jobs are stopped cooperatively by worker cancellation checks.
    };
    await remove(this.ingestion, `ingest-${batchId}`);
    await Promise.all(callRecordingIds.map((id) =>
      remove(this.transcription, `transcribe-${id}-${this.config.TRANSCRIPTION_MODEL_VERSION}`)));
    await Promise.all(analysisGroupIds.map((id) =>
      remove(this.analysis, `analyze-${id}-${this.config.ANALYSIS_PROMPT_VERSION}`)));
    await Promise.all(customerIds.map((id) => remove(this.recurrence, `recurrence-${id}-${batchId}`)));
  }

  async close(): Promise<void> {
    await Promise.all([this.ingestion.close(), this.transcription.close(), this.analysis.close(), this.recurrence.close()]);
    this.connection.disconnect();
  }
}
