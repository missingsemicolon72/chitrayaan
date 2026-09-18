import pino from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/api/app.js';
import { createTranscodeWorker, type TranscodeWorkerHandle } from '../../src/lib/queue/index.js';
import { createJobRunner } from '../../src/worker/runner.js';
import type { TranscodeProcessor } from '../../src/worker/types.js';

/** Stand-in for the real transcode: just checks the source exists and reports progress. */
const statSourceProcessor: TranscodeProcessor = async ({ video, storage, reportProgress }) => {
  if (!video.sourceKey) throw new Error(`video ${video.id} has no source file recorded`);
  if (!(await storage.exists(video.sourceKey))) {
    throw new Error(`source object ${video.sourceKey} not found in storage`);
  }
  await reportProgress(50);
  await reportProgress(100);
};
import { createTestApp, type TestApp } from '../helpers/app.js';
import { redisAvailable, TEST_REDIS_URL } from '../helpers/redis.js';
import { waitFor } from '../helpers/wait.js';

const REDIS = await redisAvailable();
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const silent = pino({ level: 'silent' });

describe.skipIf(!REDIS)('transcode queue + worker', () => {
  let t: TestApp;
  let worker: TranscodeWorkerHandle | undefined;

  const startWorker = (processor: TranscodeProcessor = statSourceProcessor) => {
    worker = createTranscodeWorker({
      redisUrl: TEST_REDIS_URL,
      prefix: t.queuePrefix,
      concurrency: 1,
      processor: createJobRunner({ db: t.app.db, storage: t.app.storage, processor, log: silent }),
    });
    return worker;
  };

  const settled = (jobId: string) =>
    waitFor(
      () => t.app.db.jobs.get(jobId),
      (job) => job?.status === 'completed' || job?.status === 'failed',
    );

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
  });

  afterAll(async () => {
    await t.close();
  });

  it('runs a queued job through a processor and records every transition', async () => {
    await t.app.storage.put('uploads/vid-ok', 'fake source bytes');
    const video = await t.app.db.videos.create({
      id: 'vid-ok',
      status: 'uploaded',
      sourceKey: 'uploads/vid-ok',
    });
    const job = await t.app.db.jobs.create({ videoId: video.id });

    expect(await t.queue.enqueue(job)).toBe(job.id);
    expect((await t.queue.getState(job.id))?.state).toBe('waiting');

    startWorker();
    const done = await settled(job.id);
    expect(done).toMatchObject({
      status: 'completed',
      progress: 100,
      attempts: 1,
      queueJobId: job.id,
      error: null,
    });
    expect(done?.startedAt).toMatch(ISO_UTC);
    expect(done?.finishedAt).toMatch(ISO_UTC);
    expect((await t.app.db.videos.get(video.id))?.status).toBe('ready');

    // BullMQ moves the job to `completed` just after the processor resolves; wait for it.
    const live = await waitFor(
      () => t.queue.getState(job.id),
      (state) => state?.state === 'completed',
    );
    expect(live).toMatchObject({ state: 'completed', attemptsMade: 1, progress: 100 });
  });

  it('marks the job and video failed when the processor throws', async () => {
    const video = await t.app.db.videos.create({
      id: 'vid-missing-source',
      status: 'uploaded',
      sourceKey: 'uploads/does-not-exist',
    });
    const job = await t.app.db.jobs.create({ videoId: video.id });
    await t.queue.enqueue(job);

    startWorker();
    const done = await settled(job.id);
    expect(done?.status).toBe('failed');
    expect(done?.error).toMatch(/uploads\/does-not-exist not found/);
    expect(done?.finishedAt).toMatch(ISO_UTC);

    const failedVideo = await t.app.db.videos.get(video.id);
    expect(failedVideo?.status).toBe('failed');
    expect(failedVideo?.error).toBe(done?.error);
    const live = await waitFor(
      () => t.queue.getState(job.id),
      (state) => state?.state === 'failed',
    );
    expect(live?.failedReason).toMatch(/uploads\/does-not-exist not found/);
  });

  it('passes progress reports through to the database and the queue', async () => {
    await t.app.storage.put('uploads/vid-progress', 'x');
    const video = await t.app.db.videos.create({
      id: 'vid-progress',
      status: 'uploaded',
      sourceKey: 'uploads/vid-progress',
    });
    const job = await t.app.db.jobs.create({ videoId: video.id });
    await t.queue.enqueue(job);

    const seen: number[] = [];
    startWorker(async ({ reportProgress }) => {
      for (const pct of [10, 10, 42.9, 100]) {
        await reportProgress(pct);
        seen.push((await t.app.db.jobs.get(job.id))?.progress ?? -1);
      }
    });
    await settled(job.id);
    expect(seen).toEqual([10, 10, 42, 100]);
  });

  it('enqueue is idempotent per job id', async () => {
    const video = await t.app.db.videos.create({ id: 'vid-dup', status: 'uploaded' });
    const job = await t.app.db.jobs.create({ videoId: video.id });
    expect(await t.queue.enqueue(job)).toBe(job.id);
    expect(await t.queue.enqueue(job)).toBe(job.id);
    expect(await t.queue.queue.getWaitingCount()).toBeGreaterThanOrEqual(1);
    const waiting = await t.queue.queue.getWaiting();
    expect(waiting.filter((j) => j.id === job.id)).toHaveLength(1);
  });

  it('reconciles database jobs that never reached Redis at startup', async () => {
    const video = await t.app.db.videos.create({ id: 'vid-orphan', status: 'uploaded' });
    const orphan = await t.app.db.jobs.create({ videoId: video.id });
    expect(orphan.queueJobId).toBeNull();
    expect(await t.queue.getState(orphan.id)).toBeNull();

    const second = await buildApp(t.app.config, {
      db: t.app.db,
      storage: t.app.storage,
      queue: t.queue,
    });
    try {
      expect((await t.app.db.jobs.get(orphan.id))?.queueJobId).toBe(orphan.id);
      expect((await t.queue.getState(orphan.id))?.state).toBe('waiting');
    } finally {
      await second.close();
    }
  });

  it('GET /api/jobs/:id includes the live queue state', async () => {
    const video = await t.app.db.videos.create({ id: 'vid-api', status: 'uploaded' });
    const job = await t.app.db.jobs.create({ videoId: video.id });
    await t.queue.enqueue(job);

    const res = await t.app.inject({
      method: 'GET',
      url: `/api/jobs/${job.id}`,
      headers: { 'x-api-key': t.apiKey },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: job.id,
      status: 'queued',
      queue: { state: 'waiting', attemptsMade: 0 },
    });
  });

  it('/healthz reports redis ok', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok', checks: { db: 'ok', redis: 'ok' } });
  });
});
