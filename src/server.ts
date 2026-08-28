import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { Repository } from './db/repository.js';
import { TranscriptionRepository } from './db/transcription.repository.js';
import { AnalysisRepository } from './db/analysis.repository.js';
import { CallRepository } from './db/call.repository.js';
import { DashboardRepository } from './db/dashboard.repository.js';
import { SettingsRepository } from './db/settings.repository.js';
import { ChatRepository } from './db/chat.repository.js';
import { ObjectStorage } from './services/storage.js';
import { createApp } from './app.js';
import { QueueService } from './queues/queue.service.js';
import { ChatService } from './services/chat.js';
import { CoachingInsightService } from './services/coachingInsight.js';

const config = loadConfig();
const pool = createPool(config);
const repository = new Repository(pool, config.STAGING_RETENTION_DAYS);
const transcriptionRepository = new TranscriptionRepository(pool);
const analysisRepository = new AnalysisRepository(pool);
const callRepository = new CallRepository(pool);
const dashboardRepository = new DashboardRepository(pool);
const settingsRepository = new SettingsRepository(pool);
const chatRepository = new ChatRepository(pool);
const chatService = new ChatService(config, chatRepository);
const coachingInsightService = new CoachingInsightService(config);
const storage = new ObjectStorage(config);
const queues = new QueueService(config);
const app = createApp(
  config, repository, transcriptionRepository, analysisRepository, callRepository, dashboardRepository,
  settingsRepository, storage, queues, chatService, coachingInsightService
);

const server = app.listen(config.PORT, () => console.log(`CareSense listening on http://localhost:${config.PORT}`));

let shutdownPromise: Promise<void> | undefined;
function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    server.close();
    await queues.close();
    await pool.end();
  })();
  return shutdownPromise;
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
