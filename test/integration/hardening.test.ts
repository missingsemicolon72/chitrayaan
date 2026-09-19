import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/api/app.js';
import type { Database } from '../../src/lib/db/index.js';
import {
  createTranscodeWorker,
  TranscodeQueue,
  UnrecoverableError,
  type TranscodeWorkerHandle,
} from '../../src/lib/queue/index.js';
import { FfmpegError, runFfmpeg } from '../../src/lib/transcode/index.js';
import { sweepStaleWorkDirs } from '../../src/worker/cleanup.js';
import { createJobRunner } from '../../src/worker/runner.js';
import type { TranscodeProcessor } from '../../src/worker/types.js';
import { createTestApp, type TestApp } from '../helpers/app.js';
import { FFMPEG_PATH, ffmpegAvailable } from '../helpers/ffmpeg.js';
import { redisAvailable, TEST_REDIS_URL } from '../helpers/redis.js';
import { waitFor } from '../helpers/wait.js';

const REDIS = await redisAvailable();
const FFMPEG = await ffmpegAvailable();
const silent = pino({ level: 'silent' });

describe.skipIf(!REDIS)('retries', () => {
  let t: TestApp;
  let worker: TranscodeWorkerHandle | undefined;
  /** A queue that retries, unlike the single-attempt default the other suites use. */
  let retryQueue: TranscodeQueue;

  const startWorker = (processor: TranscodeProcessor) => {
    worker = createTranscodeWorker({
      redisUrl: TEST_REDIS_URL,
      prefix: t.queuePrefix,
      processor: createJobRunner({
        db: t.app.db,
        storage: t.app.storage,
        processor,
        log: silent,
      }),
    });
  };

  const settled = (jobId: string) =>
    waitFor(
      () => t.app.db.jobs.get(jobId),
      (job) => job?.status === 'completed' || job?.status === 'failed',
      { timeoutMs: 20_000 },
    );

  const seedJob = async (id: string) => {
    await t.app.storage.put(`uploads/${id}`, 'source bytes');
    const video = await t.app.db.videos.create({
      id,
      status: 'uploaded',
      sourceKey: `uploads/${id}`,
    });
    return t.app.db.jobs.create({ videoId: video.id });
  };

  beforeAll(async () => {
    t = await createTestApp();
    retryQueue = new TranscodeQueue(TEST_REDIS_URL, {
      prefix: t.queuePrefix,
      attempts: 3,
      backoffMs: 50,
    });
  });

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
  });

  afterAll(async () => {
    await retryQueue.close();
    await t.close();
  });

  it('retries a transient failure and records the attempt count', async () => {
    const job = await seedJob('vid-flaky');
    await retryQueue.enqueue(job);

    let calls = 0;
    startWorker(async () => {
      calls += 1;
      if (calls < 3) throw new Error(`transient failure ${calls}`);
      await Promise.resolve();
    });

    const done = await settled(job.id);
    expect(calls).toBe(3);
    expect(done).toMatchObject({ status: 'completed', attempts: 3, progress: 100, error: null });
    expect((await t.app.db.videos.get('vid-flaky'))?.status).toBe('ready');
  }, 30_000);

  it('gives up after the configured attempts and leaves the error on the record', async () => {
    const job = await seedJob('vid-always-broken');
    await retryQueue.enqueue(job);

    let calls = 0;
    startWorker(() => {
      calls += 1;
      return Promise.reject(new Error('disk is on fire'));
    });

    const done = await settled(job.id);
    expect(calls).toBe(3);
    expect(done).toMatchObject({ status: 'failed', attempts: 3 });
    expect(done?.error).toMatch(/disk is on fire/);
    const video = await t.app.db.videos.get('vid-always-broken');
    expect(video?.status).toBe('failed');
    expect(video?.error).toMatch(/disk is on fire/);
  }, 30_000);

  it('never retries an unrecoverable failure, however many attempts are configured', async () => {
    const job = await seedJob('vid-bad-input');
    await retryQueue.enqueue(job);

    let calls = 0;
    startWorker(() => {
      calls += 1;
      return Promise.reject(new UnrecoverableError('source file is unusable: moov atom not found'));
    });

    const done = await settled(job.id);
    expect(calls).toBe(1);
    expect(done).toMatchObject({ status: 'failed', attempts: 1 });
    expect(done?.error).toMatch(/moov atom not found/);
  }, 30_000);
});

describe.skipIf(!FFMPEG)('transcode timeout', () => {
  it('kills a long-running FFmpeg when its deadline passes', async () => {
    const started = Date.now();
    const err = await runFfmpeg(
      // 60s of synthetic video would take far longer than the deadline allows.
      ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '60', '-f', 'null', '-'],
      { ffmpegPath: FFMPEG_PATH, signal: AbortSignal.timeout(400) },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FfmpegError);
    expect((err as FfmpegError).message).toMatch(/aborted/);
    // The process is killed rather than left to finish.
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);
});

describe('stale work directories', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'chitrayaan-sweep-'));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('removes only old chitrayaan work directories', async () => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    for (const name of ['chitrayaan-aaaa-1', 'chitrayaan-bbbb-2', 'somebody-elses-dir']) {
      await mkdir(path.join(root, name), { recursive: true });
      await writeFile(path.join(root, name, 'scratch.txt'), 'x');
      await utimes(path.join(root, name), old, old);
    }
    await mkdir(path.join(root, 'chitrayaan-fresh-3'), { recursive: true });
    await writeFile(path.join(root, 'keep-me.txt'), 'x');

    expect(await sweepStaleWorkDirs(root, silent)).toBe(2);
    expect((await readdir(root)).sort()).toEqual([
      'chitrayaan-fresh-3',
      'keep-me.txt',
      'somebody-elses-dir',
    ]);
  });

  it('is a no-op when the work root does not exist yet', async () => {
    expect(await sweepStaleWorkDirs(path.join(root, 'not-created'), silent)).toBe(0);
  });
});

describe('abandoned uploads', () => {
  /** A sub-second expiry, so rows created before a short wait count as abandoned. */
  const EXPIRY_HOURS = '0.0002'; // 0.72 seconds

  it('deletes abandoned uploads but never a finished one, however old', async () => {
    const t = await createTestApp({ env: { UPLOAD_EXPIRY_HOURS: EXPIRY_HOURS } });
    try {
      // Abandoned: started, partially written, then left alone.
      await t.app.db.videos.create({ id: 'vid-abandoned', status: 'uploading' });
      await t.app.storage.put('uploads/vid-abandoned', 'partial bytes');
      // Orphaned placeholder: the row outlived its bytes.
      await t.app.db.videos.create({ id: 'vid-orphan-row', status: 'uploading' });
      // Finished long ago: its source must survive, because re-transcoding needs it.
      await t.app.db.videos.create({ id: 'vid-done', status: 'uploaded' });
      await t.app.storage.put('uploads/vid-done', 'the whole source file');
      // Still being written: the record is old but the bytes are fresh.
      await t.app.db.videos.create({ id: 'vid-active', status: 'uploading' });

      await new Promise((resolve) => setTimeout(resolve, 900));
      await t.app.storage.put('uploads/vid-active', 'just written another chunk');
      // Created after the wait, so still inside the expiry window.
      await t.app.db.videos.create({ id: 'vid-recent', status: 'uploading' });

      const result = await t.app.sweepExpiredUploads();
      expect(result).toEqual({ uploads: 1, videos: 2 });

      expect(await t.app.db.videos.get('vid-abandoned')).toBeNull();
      expect(await t.app.storage.exists('uploads/vid-abandoned')).toBe(false);
      expect(await t.app.db.videos.get('vid-orphan-row')).toBeNull();

      // The three that must be left alone.
      expect(await t.app.db.videos.get('vid-done')).not.toBeNull();
      expect(await t.app.storage.exists('uploads/vid-done')).toBe(true);
      expect(await t.app.db.videos.get('vid-active')).not.toBeNull();
      expect(await t.app.storage.exists('uploads/vid-active')).toBe(true);
      expect(await t.app.db.videos.get('vid-recent')).not.toBeNull();
    } finally {
      await t.close();
    }
  }, 20_000);

  it('keeps the source of a video that has already been transcoded', async () => {
    const t = await createTestApp({ env: { UPLOAD_EXPIRY_HOURS: EXPIRY_HOURS } });
    try {
      for (const status of ['uploaded', 'processing', 'ready', 'failed'] as const) {
        const id = `vid-${status}`;
        await t.app.db.videos.create({ id, status });
        await t.app.storage.put(`uploads/${id}`, 'source bytes');
      }
      await new Promise((resolve) => setTimeout(resolve, 900));

      expect(await t.app.sweepExpiredUploads()).toEqual({ uploads: 0, videos: 0 });
      for (const status of ['uploaded', 'processing', 'ready', 'failed'] as const) {
        expect(await t.app.storage.exists(`uploads/vid-${status}`), status).toBe(true);
        expect(await t.app.db.videos.get(`vid-${status}`), status).not.toBeNull();
      }
    } finally {
      await t.close();
    }
  }, 20_000);

  it('does nothing when the sweep is disabled', async () => {
    const off = await createTestApp({ env: { UPLOAD_EXPIRY_HOURS: '0' } });
    try {
      await off.app.db.videos.create({ id: 'vid-x', status: 'uploading' });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await off.app.sweepExpiredUploads()).toEqual({ uploads: 0, videos: 0 });
      expect(await off.app.db.videos.get('vid-x')).not.toBeNull();
    } finally {
      await off.close();
    }
  });
});

describe('error responses', () => {
  it('never leaks internals on a 500, but keeps validation messages', async () => {
    const t = await createTestApp();
    try {
      const broken: Database = {
        backend: 'sqlite',
        jobs: t.app.db.jobs,
        renditions: t.app.db.renditions,
        subtitles: t.app.db.subtitles,
        videos: {
          ...t.app.db.videos,
          get: () => Promise.reject(new Error('connection string: postgres://user:hunter2@host')),
        },
        ping: () => Promise.resolve(),
        migrate: () => Promise.resolve(),
        close: () => Promise.resolve(),
      };
      const app = await buildApp(t.app.config, {
        db: broken,
        storage: t.app.storage,
        queue: t.queue,
      });
      try {
        const res = await app.inject({
          method: 'GET',
          url: '/api/videos/anything',
          headers: { 'x-api-key': t.apiKey },
        });
        expect(res.statusCode).toBe(500);
        const body = res.json<{ statusCode: number; error: string; message: string }>();
        expect(body).toEqual({
          statusCode: 500,
          error: 'Internal Server Error',
          message: 'the server could not complete this request',
        });
        expect(res.body).not.toContain('hunter2');

        // Client mistakes still say what was wrong.
        const bad = await app.inject({
          method: 'GET',
          url: '/api/videos?limit=0',
          headers: { 'x-api-key': t.apiKey },
        });
        expect(bad.statusCode).toBe(400);
        expect(bad.json<{ message: string }>().message).toMatch(/limit/);
      } finally {
        await app.close();
      }
    } finally {
      await t.close();
    }
  });
});
