import { bootstrapConfig } from '../config/index.js';
import { createLogger } from '../lib/logger.js';
import { RtmpListener } from '../lib/rtmp/index.js';
import { binaryVersion } from '../lib/transcode/index.js';

/**
 * Live ingest process entrypoint (`npm run dev:live` / `start:live`). It runs apart from the API,
 * so restarting or redeploying the API never cuts a live stream and a fault in live ingest never
 * takes the API down. It serves the single live stream: run exactly one.
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

const listener = new RtmpListener({
  ffmpegPath: config.FFMPEG_PATH,
  host: config.HOST,
  port: config.RTMP_LISTEN_PORT,
  streamKey,
  logger: log,
});
listener.start();

let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal }, 'shutting down');
  listener
    .stop()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      log.error(err, 'error during shutdown');
      process.exit(1);
    });
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
