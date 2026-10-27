import os from 'node:os';
import path from 'node:path';

import { bootstrapConfig } from '../config/index.js';
import { createDatabase } from '../lib/db/index.js';
import { createLogger } from '../lib/logger.js';
import { LIVE_WORK_DIR_NAME } from '../lib/packaging/index.js';
import { createStorage } from '../lib/storage/index.js';
import { binaryVersion } from '../lib/transcode/index.js';
import { LiveController } from './controller.js';

/**
 * Live ingest process entrypoint (`npm run dev:live` / `start:live`). It runs apart from the API
 * (decision #21), so restarting or redeploying the API never cuts a live stream and a fault in
 * live ingest never takes the API down. It serves the single live stream: run exactly one.
 *
 * Streams are created and stopped through the API, which records them in the shared database;
 * this process picks them up from there (see LiveController).
 */
const config = bootstrapConfig();
const log = createLogger(config, 'live');

const streamKey = config.RTMP_STREAM_KEY;
if (streamKey === undefined) {
  log.fatal('RTMP_STREAM_KEY is not set; live ingest needs it to accept a publisher');
  process.exit(1);
}

// Fail fast if FFmpeg is missing: the listener would only retry forever otherwise.
try {
  log.info({ ffmpeg: await binaryVersion(config.FFMPEG_PATH) }, 'ffmpeg available');
} catch (err) {
  log.fatal({ err }, 'ffmpeg not runnable; set FFMPEG_PATH');
  process.exit(1);
}

const db = await createDatabase(config);
await db.migrate();
const storage = await createStorage(config);
const workRoot = path.join(config.WORK_DIR ?? os.tmpdir(), LIVE_WORK_DIR_NAME);
const controller = new LiveController({
  db,
  ffmpegPath: config.FFMPEG_PATH,
  host: config.HOST,
  port: config.RTMP_LISTEN_PORT,
  streamKey,
  storage,
  workRoot,
  logger: log,
  cleanupDelaySeconds: config.LIVE_CLEANUP_DELAY_SECONDS,
});
await controller.start();
log.info(
  { db: db.backend, storage: storage.backend, workRoot, port: config.RTMP_LISTEN_PORT },
  'live ingest ready: start a stream with POST /api/live/streams, then publish to it',
);

let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down');
  controller
    .stop()
    .then(() => db.close())
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      log.error(err, 'error during shutdown');
      process.exit(1);
    });
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
