import type { Database } from '../lib/db/index.js';
import type { Logger } from '../lib/logger.js';
import { UnrecoverableError, type TranscodeProcessorFn } from '../lib/queue/index.js';
import type { ObjectStorage } from '../lib/storage/index.js';
import type { TranscodeProcessor } from './types.js';

export interface JobRunnerDeps {
  db: Database;
  storage: ObjectStorage;
  processor: TranscodeProcessor;
  log: Logger;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Wraps a `TranscodeProcessor` as a BullMQ processor and keeps the database in step with the
 * queue: job -> active/completed/failed (+ attempts, timestamps, progress, error), video ->
 * processing/ready/failed. Throws through to BullMQ so it can apply its own retry policy.
 */
export function createJobRunner(deps: JobRunnerDeps): TranscodeProcessorFn {
  const { db, storage, processor } = deps;
  const now = () => new Date().toISOString();

  return async (queueJob) => {
    const { jobId, videoId } = queueJob.data;
    const attempt = queueJob.attemptsMade + 1;
    const log = deps.log.child({ jobId, videoId, queueJobId: queueJob.id, attempt });

    const job = await db.jobs.get(jobId);
    if (!job) throw new UnrecoverableError(`job ${jobId} has no database record`);
    const video = await db.videos.get(videoId);
    if (!video) {
      const message = `video ${videoId} has no database record`;
      await db.jobs.update(jobId, { status: 'failed', error: message, finishedAt: now() });
      throw new UnrecoverableError(message);
    }

    await db.jobs.update(jobId, {
      status: 'active',
      attempts: attempt,
      progress: 0,
      startedAt: now(),
      finishedAt: null,
      error: null,
      queueJobId: queueJob.id ?? null,
    });
    await db.videos.update(videoId, { status: 'processing', error: null });
    log.info('job started');

    let lastReported = -1;
    const reportProgress = async (percent: number): Promise<void> => {
      const clamped = Math.max(0, Math.min(100, Math.floor(percent)));
      if (clamped === lastReported) return;
      lastReported = clamped;
      await Promise.all([
        queueJob.updateProgress(clamped),
        db.jobs.update(jobId, { progress: clamped }),
      ]);
    };

    try {
      await processor({ job, video, db, storage, log, reportProgress });
      await db.jobs.update(jobId, { status: 'completed', progress: 100, finishedAt: now() });
      await db.videos.update(videoId, { status: 'ready', error: null });
      log.info('job completed');
    } catch (err) {
      const message = errorMessage(err);
      const maxAttempts = queueJob.opts.attempts ?? 1;
      const willRetry = !(err instanceof UnrecoverableError) && attempt < maxAttempts;
      await db.jobs.update(jobId, {
        status: willRetry ? 'queued' : 'failed',
        error: message,
        finishedAt: willRetry ? null : now(),
      });
      if (!willRetry) await db.videos.update(videoId, { status: 'failed', error: message });
      log.error({ err, willRetry }, 'job failed');
      throw err;
    }
  };
}
