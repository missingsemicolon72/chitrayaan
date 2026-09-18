import type { Database } from '../db/index.js';
import type { MinimalLogger } from '../logger.js';
import type { TranscodeQueue } from './index.js';

const PAGE = 200;

/**
 * Enqueue database jobs that are `queued` but never reached Redis (Redis was down when the
 * upload finished). Runs at API startup; a periodic sweep can join it in Milestone 10.
 * Stops at the first enqueue failure, since that means Redis is still unavailable.
 * Returns the number of jobs handed to the queue.
 */
export async function reconcileQueuedJobs(
  db: Database,
  queue: TranscodeQueue,
  log: MinimalLogger,
): Promise<number> {
  let enqueued = 0;
  for (let offset = 0; ; offset += PAGE) {
    const page = await db.jobs.list({ status: 'queued', limit: PAGE, offset });
    for (const job of page.items) {
      if (job.queueJobId !== null) continue;
      try {
        const queueJobId = await queue.enqueue(job);
        await db.jobs.update(job.id, { queueJobId });
        enqueued += 1;
        log.info({ jobId: job.id, videoId: job.videoId }, 'reconciled job into queue');
      } catch (err) {
        log.warn(
          { err, jobId: job.id },
          'could not reconcile queued job into Redis; will retry at next startup',
        );
        return enqueued;
      }
    }
    if (offset + page.items.length >= page.total) return enqueued;
  }
}
