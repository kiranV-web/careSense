import { loadConfig } from '../config.js';
import { QueueService } from '../queues/queue.service.js';

const confirmationFlag = '--yes';
if (!process.argv.includes(confirmationFlag)) {
  throw new Error(`Queue reset requires confirmation. Run: npm run flush:queues -- ${confirmationFlag}`);
}

const config = loadConfig();
if (config.NODE_ENV === 'production') {
  throw new Error('flush:queues is disabled when NODE_ENV=production');
}

const queues = new QueueService(config);
try {
  await queues.ready();
  const namedQueues = [
    ['ingestion', queues.ingestion],
    ['transcription', queues.transcription],
    ['analysis', queues.analysis],
    ['recurrence', queues.recurrence]
  ] as const;
  for (const [name, queue] of namedQueues) {
    const counts = await queue.getJobCounts('active', 'waiting', 'delayed', 'prioritized', 'completed', 'failed');
    const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
    await queue.obliterate({ force: true });
    console.log(`${name} queue jobs removed: ${total}`);
  }
  console.log('All CareSense BullMQ queue keys were removed');
  console.log('PostgreSQL, local staging, and Cloudflare R2 were not changed');
} finally {
  await queues.close();
}
