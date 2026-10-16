import os from 'node:os';
import path from 'node:path';

import { bootstrapConfig } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { LIVE_WORK_DIR_NAME } from '../lib/packaging/index.js';
import { createStorage } from '../lib/storage/index.js';
import { binaryVersion } from '../lib/transcode/index.js';
import { LiveIngest } from './ingest.js';

/**
 * Live ingest process entrypoint (`npm run dev:live` / `start:live`). It runs apart from the API
 * (decision #21), so restarting or redeploying the API never cuts a live stream and a fault in
 * live ingest never takes the API down. It serves the single live stream: run exactly one.
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

const storage = await createStorage(config);
const workRoot = path.join(config.WORK_DIR ?? os.tmpdir(), LIVE_WORK_DIR_NAME);
const ingest = new LiveIngest({
  ffmpegPath: config.FFMPEG_PATH,
  host: config.HOST,
  port: config.RTMP_LISTEN_PORT,
  streamKey,
  storage,
  workRoot,
  logger: log,
});
await ingest.start();
log.info({ storage: storage.backend, workRoot }, 'live ingest ready');

let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down');
  ingest
    .stop()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      log.error(err, 'error during shutdown');
      process.exit(1);
    });
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
