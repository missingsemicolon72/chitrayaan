import { access, constants } from 'node:fs/promises';
import os from 'node:os';

import { bootstrapConfig } from '../config/index.js';
import { createDatabase } from '../lib/db/index.js';
import { createLogger } from '../lib/logger.js';
import { createTranscodeWorker, TRANSCODE_QUEUE_NAME } from '../lib/queue/index.js';
import { createStorage } from '../lib/storage/index.js';
import { binaryVersion } from '../lib/transcode/index.js';
import { sweepStaleWorkDirs } from './cleanup.js';
import { createTranscodeProcessor } from './processors/transcode.js';
import { createJobRunner } from './runner.js';

/**
 * Worker process entrypoint. Runs alongside the API (`npm run dev:worker` / `start:worker`),
 * shares its database and storage, and consumes the transcode queue from Redis.
 */
const config = bootstrapConfig();
const log = createLogger(config, 'worker');

// Fail fast if FFmpeg is missing: every job would fail otherwise.
try {
  const [ffmpeg, ffprobe] = await Promise.all([
    binaryVersion(config.FFMPEG_PATH),
    binaryVersion(config.FFPROBE_PATH),
  ]);
  log.info({ ffmpeg, ffprobe }, 'ffmpeg available');
} catch (err) {
  log.fatal({ err }, 'ffmpeg/ffprobe not runnable; set FFMPEG_PATH / FFPROBE_PATH');
  process.exit(1);
}

// The watermark image is read on every job, so check it once at startup.
const watermark =
  config.FEATURE_WATERMARK && config.WATERMARK_IMAGE_PATH
    ? {
        imagePath: config.WATERMARK_IMAGE_PATH,
        position: config.WATERMARK_POSITION,
        opacity: config.WATERMARK_OPACITY,
      }
    : undefined;
if (watermark) {
  try {
    await access(watermark.imagePath, constants.R_OK);
    log.info(watermark, 'watermark enabled');
  } catch {
    log.fatal(
      { imagePath: watermark.imagePath },
      'WATERMARK_IMAGE_PATH is not readable; fix it or set FEATURE_WATERMARK=false',
    );
    process.exit(1);
  }
}

const db = await createDatabase(config);
await db.migrate();
const storage = await createStorage(config);

const processor = createTranscodeProcessor({
  ffmpegPath: config.FFMPEG_PATH,
  ffprobePath: config.FFPROBE_PATH,
  preset: config.FFMPEG_PRESET,
  av1Preset: config.AV1_PRESET,
  codecs: config.CODEC_LADDER,
  formats: config.PACKAGE_FORMATS,
  thumbnails: config.FEATURE_THUMBNAILS,
  timeoutMs: config.TRANSCODE_TIMEOUT_MINUTES * 60_000,
  ...(watermark ? { watermark } : {}),
  ...(config.WORK_DIR ? { workDir: config.WORK_DIR } : {}),
});

// A worker killed mid-job leaves its scratch directory behind.
await sweepStaleWorkDirs(config.WORK_DIR ?? os.tmpdir(), log);

let lastRedisErrorAt = 0;
const handle = createTranscodeWorker({
  redisUrl: config.REDIS_URL,
  concurrency: config.WORKER_CONCURRENCY,
  processor: createJobRunner({ db, storage, processor, log }),
  onError: (err) => {
    // ioredis emits one error per reconnect attempt; keep the log readable.
    const now = Date.now();
    if (now - lastRedisErrorAt > 30_000) {
      lastRedisErrorAt = now;
      log.error({ err: err.message }, 'redis connection error (will keep retrying)');
    }
  },
});

handle.worker.on('ready', () => log.info('connected to redis, waiting for jobs'));
handle.worker.on('stalled', (jobId) => log.warn({ queueJobId: jobId }, 'job stalled'));

log.info(
  {
    queue: TRANSCODE_QUEUE_NAME,
    concurrency: config.WORKER_CONCURRENCY,
    preset: config.FFMPEG_PRESET,
    codecs: config.CODEC_LADDER,
    ...(config.CODEC_LADDER.includes('av1') ? { av1Preset: config.AV1_PRESET } : {}),
    formats: config.PACKAGE_FORMATS,
    timeoutMinutes: config.TRANSCODE_TIMEOUT_MINUTES,
    features: {
      thumbnails: config.FEATURE_THUMBNAILS,
      subtitles: config.FEATURE_SUBTITLES,
      watermark: config.FEATURE_WATERMARK,
    },
    db: db.backend,
    storage: storage.backend,
  },
  'worker started',
);

let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down, waiting for in-flight jobs');
  handle
    .close()
    .then(() => db.close())
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      log.error(err, 'error during shutdown');
      process.exit(1);
    });
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
