import express from 'express';
import pino from 'pino';
import { pinoHttp } from 'pino-http';
import { z, ZodError } from 'zod';
import type { Config } from './config.js';
import type { Repository } from './db/repository.js';
import type { TranscriptionRepository } from './db/transcription.repository.js';
import type { AnalysisRepository } from './db/analysis.repository.js';
import type { CallRepository } from './db/call.repository.js';
import type { DashboardRepository, DashboardPeriod, TeamPeriod } from './db/dashboard.repository.js';
import { CALL_ETIQUETTE_RULES, type SettingsRepository } from './db/settings.repository.js';
import type { ObjectStorage } from './services/storage.js';
import { uploadHandler } from './api/upload.js';
import type { QueueService } from './queues/queue.service.js';
import { parseByteRange } from './api/range.js';
import { callStatuses, issueCategories, resolutionStatuses, urgencyLevels } from './services/analysis.js';
import type { ChatService } from './services/chat.js';
import type { CoachingInsightService } from './services/coachingInsight.js';

const booleanQuery = z.enum(['true', 'false']).transform((value) => value === 'true');
const pagination = {
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25)
};
const callListQuery = z.object({
  batch_id: z.string().uuid().optional(), customer_id: z.string().uuid().optional(),
  agent_id: z.string().min(1).max(255).optional(),
  issue_category: z.enum(issueCategories).optional(), device_model: z.string().min(1).max(255).optional(),
  banking_product: z.string().min(1).max(80).optional(),
  resolution_status: z.enum(resolutionStatuses).optional(),
  call_status: z.enum(callStatuses).optional(), needs_manager_attention: booleanQuery.optional(),
  urgency_level: z.enum(urgencyLevels).optional(),
  processing_state: z.enum(['TRANSCRIBING', 'ANALYZING', 'LINKING_RECURRING_CALLS', 'COMPLETED', 'FAILED']).optional(),
  started_from: z.string().datetime({ offset: true }).optional(), started_to: z.string().datetime({ offset: true }).optional(),
  ...pagination
}).strict();
const groupedCallListQuery = z.object({
  ...pagination,
  started_from: z.string().datetime({ offset: true }).optional(),
  started_to: z.string().datetime({ offset: true }).optional()
}).strict();
const managerListQuery = z.object({
  status: z.enum(['OPEN', 'IN_REVIEW', 'CLOSED']).optional(), urgency_level: z.enum(urgencyLevels).optional(), ...pagination
}).strict();
const managerUpdateBody = z.object({
  status: z.enum(['OPEN', 'IN_REVIEW', 'CLOSED']), manager_notes: z.string().max(5_000).nullable().optional()
}).strict();
const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'date must use YYYY-MM-DD').refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}, 'date must be a real calendar date');
const dashboardPeriodQuery = z.object({
  date: dateString.optional(), timezone: z.string().min(1).max(100).default('Asia/Kolkata')
}).strict().superRefine((value, context) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value.timezone }).format();
  } catch {
    context.addIssue({ code: 'custom', path: ['timezone'], message: 'Unknown IANA timezone' });
  }
});
const teamPeriodQuery = z.object({
  date: dateString.optional(), date_from: dateString.optional(), date_to: dateString.optional(),
  timezone: z.string().min(1).max(100).default('Asia/Kolkata')
}).strict().superRefine((value, context) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value.timezone }).format();
  } catch {
    context.addIssue({ code: 'custom', path: ['timezone'], message: 'Unknown IANA timezone' });
  }
  if ((value.date_from && !value.date_to) || (!value.date_from && value.date_to)) {
    context.addIssue({ code: 'custom', path: ['date_from'], message: 'date_from and date_to must be provided together' });
  }
  if (value.date_from && value.date_to && value.date_from > value.date_to) {
    context.addIssue({ code: 'custom', path: ['date_from'], message: 'date_from must not be after date_to' });
  }
});
const agentCallsQuery = z.object({
  date: dateString.optional(), timezone: z.string().min(1).max(100).default('Asia/Kolkata'), ...pagination
}).strict().superRefine((value, context) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value.timezone }).format();
  } catch {
    context.addIssue({ code: 'custom', path: ['timezone'], message: 'Unknown IANA timezone' });
  }
});
const agentQualityQuery = z.object({
  agent_id: z.string().min(1).max(255)
}).strict();
const settingsUpdateBody = z.object({
  recurring_lookback_days: z.number().int().min(1).max(365).optional(),
  ideal_call_duration_seconds: z.number().int().min(1).max(86_400).optional(),
  call_etiquette: z.array(z.enum(CALL_ETIQUETTE_RULES)).min(1).max(CALL_ETIQUETTE_RULES.length)
    .refine((rules) => new Set(rules).size === rules.length, 'call_etiquette must not contain duplicates').optional()
}).strict().refine((body) => Object.keys(body).length > 0, 'At least one setting is required');
const chatMessagesBody = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'assistant']), content: z.string().min(1).max(4_000)
  }).strict()).min(1).max(40)
}).strict();

function dateInTimezone(timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function dashboardPeriod(value: { date?: string; timezone: string }): DashboardPeriod {
  return { date: value.date ?? dateInTimezone(value.timezone), timezone: value.timezone };
}

function teamPeriod(value: { date?: string; date_from?: string; date_to?: string; timezone: string }): TeamPeriod {
  const date = value.date ?? dateInTimezone(value.timezone);
  return {
    date,
    timezone: value.timezone,
    dateFrom: value.date_from ?? date,
    dateTo: value.date_to ?? date
  };
}

export function createApp(config: Config, repository: Repository, transcriptionRepository: TranscriptionRepository,
  analysisRepository: AnalysisRepository, callRepository: CallRepository, dashboardRepository: DashboardRepository,
  settingsRepository: SettingsRepository, storage: ObjectStorage, queues: QueueService, chatService: ChatService,
  coachingInsightService: CoachingInsightService) {
  const app = express();
  app.disable('x-powered-by');
  app.use(pinoHttp({ logger: pino({ level: config.NODE_ENV === 'test' ? 'silent' : 'info' }) }));
  app.use((request, response, next) => {
    response.setHeader('Access-Control-Allow-Origin', config.FRONTEND_ORIGIN);
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,OPTIONS');
    if (request.method === 'OPTIONS') {
      response.status(204).end();
      return;
    }
    next();
  });
  app.use(express.json({ limit: '32kb' }));

  app.get('/health', (_request, response) => response.json({ status: 'ok' }));
  app.get('/ready', async (_request, response) => {
    try {
      await storage.ready();
      await queues.ready();
      // Repository lookup also verifies the PostgreSQL connection without requiring a known row.
      await repository.getBatch('00000000-0000-0000-0000-000000000000');
      response.json({ status: 'ready' });
    } catch (error) {
      response.status(503).json({ status: 'not_ready', error: error instanceof Error ? error.message : 'dependency unavailable' });
    }
  });
  app.post('/api/v1/upload-batches', uploadHandler(config, repository, queues));
  app.get('/api/v1/upload-batches/:batchId', async (request, response) => {
    const batch = await repository.getBatch(request.params.batchId!);
    if (!batch) response.status(404).json({ error: 'Batch not found' });
    else response.json(batch);
  });
  app.post('/api/v1/upload-batches/:batchId/cancel', async (request, response) => {
    const batchId = z.string().uuid().parse(request.params.batchId);
    const cancelled = await repository.cancelBatch(batchId);
    if (!cancelled) {
      response.status(404).json({ error: 'Batch not found' });
      return;
    }
    if (!cancelled.cancelled) {
      response.status(409).json({ error: 'Completed or failed batches cannot be cancelled' });
      return;
    }
    await queues.cancelBatch(batchId, cancelled.callRecordingIds, cancelled.analysisGroupIds, cancelled.customerIds);
    response.json(await repository.getBatch(batchId));
  });
  app.get('/api/v1/upload-batches/:batchId/staging-errors', async (request, response) => {
    const batch = await repository.getBatch(request.params.batchId!);
    if (!batch) response.status(404).json({ error: 'Batch not found' });
    else response.json({ batch_id: request.params.batchId, errors: await repository.getStagingErrors(request.params.batchId!) });
  });
  app.get('/api/v1/upload-batches/:batchId/failed-calls', async (request, response) => {
    const batch = await repository.getBatch(request.params.batchId!);
    if (!batch) response.status(404).json({ error: 'Batch not found' });
    else response.json({ batch_id: request.params.batchId, failed_calls: await repository.getFailedCalls(request.params.batchId!) });
  });
  app.get('/api/v1/upload-batches/:batchId/events', async (request, response) => {
    const batchId = request.params.batchId!;
    if (!await repository.getBatch(batchId)) {
      response.status(404).json({ error: 'Batch not found' });
      return;
    }
    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.flushHeaders();
    let previous = '';
    let closed = false;
    const send = async (): Promise<boolean> => {
      if (closed) return true;
      const progress = await repository.getBatch(batchId);
      if (!progress) return true;
      const serialized = JSON.stringify(progress);
      if (serialized !== previous) {
        previous = serialized;
        response.write(`event: batch.progress\ndata: ${serialized}\n\n`);
      }
      if (['COMPLETED', 'COMPLETED_WITH_FAILURES', 'FAILED', 'CANCELLED'].includes(String(progress.processing_state))) {
        response.write('event: batch.finished\ndata: {}\n\n');
        response.end();
        return true;
      }
      return false;
    };
    let timer: NodeJS.Timeout | undefined;
    request.on('close', () => { closed = true; if (timer) clearInterval(timer); });
    if (!await send()) timer = setInterval(() => void send().catch(() => undefined), 1_000);
  });
  app.get('/api/v1/calls/:callId/transcription', async (request, response) => {
    const transcript = await transcriptionRepository.getTranscript(request.params.callId!);
    if (!transcript) response.status(404).json({ error: 'Call not found' });
    else response.json(transcript);
  });
  app.get('/api/v1/calls/:callId/analysis', async (request, response) => {
    const analysis = await analysisRepository.getCallAnalysis(request.params.callId!);
    if (!analysis) response.status(404).json({ error: 'Call not found' });
    else response.json(analysis);
  });
  app.get('/api/v1/calls', async (request, response) => {
    const query = callListQuery.parse(request.query);
    response.json(await callRepository.list({
      batchId: query.batch_id, customerId: query.customer_id, agentId: query.agent_id,
      issueCategory: query.issue_category, deviceModel: query.device_model, bankingProduct: query.banking_product,
      resolutionStatus: query.resolution_status,
      callStatus: query.call_status, needsManagerAttention: query.needs_manager_attention,
      urgencyLevel: query.urgency_level, processingState: query.processing_state,
      startedFrom: query.started_from, startedTo: query.started_to, page: query.page, pageSize: query.page_size
    }));
  });
  app.get('/api/v1/calls-grouped', async (request, response) => {
    const query = groupedCallListQuery.parse(request.query);
    response.json(await callRepository.listGrouped(query.page, query.page_size, query.started_from, query.started_to));
  });
  app.get('/api/v1/recurring-groups/:groupId', async (request, response) => {
    const groupId = z.string().uuid().parse(request.params.groupId);
    const group = await callRepository.getRecurringGroup(groupId);
    if (!group) response.status(404).json({ error: 'Recurring group not found' });
    else response.json(group);
  });
  app.get('/api/v1/calls/:callId', async (request, response) => {
    const detail = await callRepository.getDetail(request.params.callId!);
    if (!detail) response.status(404).json({ error: 'Call not found' });
    else response.json(detail);
  });
  app.get('/api/v1/calls/:callId/audio', async (request, response) => {
    const audio = await callRepository.getAudio(request.params.callId!);
    if (!audio) {
      response.status(404).json({ error: 'Call not found' });
      return;
    }
    let range;
    try {
      range = parseByteRange(request.headers.range, audio.bytes);
    } catch {
      response.status(416).setHeader('Content-Range', `bytes */${audio.bytes}`);
      response.end();
      return;
    }
    const object = await storage.openReadStream(audio.objectKey, range);
    response.status(range ? 206 : 200);
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Content-Type', object.contentType ?? (audio.audioFormat === 'wav' ? 'audio/wav' : 'audio/mpeg'));
    response.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(audio.filename)}`);
    response.setHeader('Content-Length', String(object.contentLength ?? (range ? range.end - range.start + 1 : audio.bytes)));
    if (range) response.setHeader('Content-Range', object.contentRange ?? `bytes ${range.start}-${range.end}/${audio.bytes}`);
    object.stream.on('error', (error) => response.destroy(error));
    object.stream.pipe(response);
  });
  app.get('/api/v1/dashboard/home', async (request, response) => {
    const query = dashboardPeriodQuery.parse(request.query);
    response.json(await dashboardRepository.getHome(dashboardPeriod(query)));
  });
  app.get('/api/v1/dashboard/team', async (request, response) => {
    const query = teamPeriodQuery.parse(request.query);
    response.json(await dashboardRepository.getTeam(teamPeriod(query)));
  });
  app.get('/api/v1/dashboard/agent-quality', async (request, response) => {
    const query = agentQualityQuery.parse(request.query);
    const result = await dashboardRepository.getAgentConversationQuality(query.agent_id);
    if (!result) response.status(404).json({ error: 'Agent not found' });
    else response.json(result);
  });
  app.get('/api/v1/dashboard/coaching-insight', async (_request, response) => {
    const signals = await dashboardRepository.getTeamCoachingSignals();
    const insight = await coachingInsightService.generate(signals);
    response.json({ insight });
  });
  app.get('/api/v1/settings', async (_request, response) => {
    response.json(await settingsRepository.get());
  });
  app.patch('/api/v1/settings', async (request, response) => {
    response.json(await settingsRepository.update(settingsUpdateBody.parse(request.body)));
  });
  app.get('/api/v1/agents/:agentId/calls', async (request, response) => {
    const agentId = z.string().min(1).max(255).parse(request.params.agentId);
    const query = agentCallsQuery.parse(request.query);
    const result = await dashboardRepository.getAgentCalls(
      agentId, dashboardPeriod(query), query.page, query.page_size
    );
    if (!result) response.status(404).json({ error: 'Agent not found' });
    else response.json(result);
  });
  app.get('/api/v1/manager-alerts', async (request, response) => {
    const query = managerListQuery.parse(request.query);
    response.json(await callRepository.listManagerAlerts(query.status, query.urgency_level, query.page, query.page_size));
  });
  app.patch('/api/v1/manager-alerts/:alertId', async (request, response) => {
    const alertId = z.string().uuid().parse(request.params.alertId);
    const body = managerUpdateBody.parse(request.body);
    const alert = await callRepository.updateManagerAlert(alertId, body.status, body.manager_notes);
    if (!alert) response.status(404).json({ error: 'Manager alert not found' });
    else response.json(alert);
  });
  app.post('/api/v1/chat/messages', async (request, response) => {
    const body = chatMessagesBody.parse(request.body);
    const result = await chatService.answer(body.messages);
    response.json({ answer: result.answer, cited_external_call_ids: result.cited_external_call_ids });
  });
  app.use((error: unknown, _request: express.Request, response: express.Response,
    _next: express.NextFunction) => {
    if (error instanceof ZodError) {
      response.status(400).json({ error: 'Invalid request', details: error.issues });
      return;
    }
    response.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
  });
  return app;
}
