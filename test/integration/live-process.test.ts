import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { FFMPEG_PATH, ffmpegAvailable } from '../helpers/ffmpeg.js';
import { freePort, portInUse, publish } from '../helpers/rtmp.js';
import { waitFor } from '../helpers/wait.js';

const FFMPEG = await ffmpegAvailable();
const STREAM_KEY = 'test-stream-key-0123456789';
const ENTRYPOINT = fileURLToPath(new URL('../../src/live/index.ts', import.meta.url));
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
const SLOW = 45_000;

type LogRecord = Record<string, unknown> & { msg?: string };

interface LiveProcess {
  child: ChildProcess;
  /** Everything it wrote to stdout and stderr so far. */
  output: () => string;
  /** Its log records so far, parsed from stdout. */
  records: () => LogRecord[];
  exited: Promise<number | null>;
}

const running: LiveProcess[] = [];
const scratchDirs: string[] = [];

/**
 * Run the real entrypoint the way `npm run dev:live` does. It runs from an empty directory, so a
 * developer's `.env` cannot leak in, and logs JSON (NODE_ENV=production) so tests can read it.
 */
async function runLive(env: Record<string, string>): Promise<LiveProcess> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'chitrayaan-live-'));
  scratchDirs.push(cwd);
  const child = spawn(process.execPath, ['--import', TSX_LOADER, ENTRYPOINT], {
    cwd,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
      API_KEY: 'a-sufficiently-long-test-key',
      HOST: '127.0.0.1',
      FFMPEG_PATH,
      RTMP_STREAM_KEY: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  const exited = new Promise<number | null>((resolve) => child.once('close', resolve));
  const live: LiveProcess = {
    child,
    output: () => stdout + stderr,
    records: () =>
      stdout
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line) as LogRecord),
    exited,
  };
  running.push(live);
  return live;
}

/**
 * Stop it as a supervisor would. Windows has no catchable SIGTERM, so there the whole process
 * tree (Node and its FFmpeg) is killed outright instead.
 */
async function stopLive(live: LiveProcess): Promise<number | null> {
  if (live.child.exitCode === null && live.child.signalCode === null) {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(live.child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      live.child.kill('SIGTERM');
    }
  }
  return live.exited;
}

/** Wait for the first log record whose message starts with `msg`. */
async function waitForLog(live: LiveProcess, msg: string, timeoutMs = 15_000): Promise<LogRecord> {
  const find = async () => live.records().find((r) => r.msg?.startsWith(msg));
  const record = await waitFor(find, (r) => r !== undefined, { timeoutMs });
  if (record === undefined) throw new Error(`no "${msg}" log record`);
  return record;
}

describe.skipIf(!FFMPEG)('live ingest process (src/live)', () => {
  afterEach(async () => {
    await Promise.all(running.splice(0).map(stopLive));
    await Promise.all(
      scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('refuses to start without RTMP_STREAM_KEY', async () => {
    const live = await runLive({});
    expect(await live.exited).toBe(1);
    expect(live.records().map((r) => r.msg)).toContain(
      'RTMP_STREAM_KEY is not set; live ingest needs it to accept a publisher',
    );
  });

  it('refuses to start when FFmpeg cannot run', async () => {
    const live = await runLive({
      RTMP_STREAM_KEY: STREAM_KEY,
      FFMPEG_PATH: 'chitrayaan-no-such-ffmpeg',
    });
    expect(await live.exited).toBe(1);
    expect(live.records().map((r) => r.msg)).toContain('ffmpeg not runnable; set FFMPEG_PATH');
  });

  it(
    'accepts a publisher on RTMP_LISTEN_PORT with RTMP_STREAM_KEY, and frees the port when stopped',
    async () => {
      const port = await freePort();
      const live = await runLive({ RTMP_STREAM_KEY: STREAM_KEY, RTMP_LISTEN_PORT: String(port) });

      const started = await waitForLog(live, 'RTMP ingest started');
      expect(started).toMatchObject({ name: 'live', port, host: '127.0.0.1' });
      // FFmpeg logs nothing once it is bound, and probing would use up its single accept.
      await new Promise((resolve) => setTimeout(resolve, 750));

      const publisher = publish({ port, streamKey: STREAM_KEY, seconds: 3 });
      const connected = await waitForLog(live, 'RTMP publisher connected');
      expect(connected).toMatchObject({
        input: { video: { codec: 'h264', width: 640, height: 360 } },
      });
      const ended = await waitForLog(live, 'RTMP stream ended');
      expect(ended).toMatchObject({ reason: 'publisher-disconnected' });
      expect(ended.receivedSeconds).toBeGreaterThan(2.5);
      expect((await publisher.done).exitCode).toBe(0);
      expect(live.output()).not.toContain(STREAM_KEY);

      const exitCode = await stopLive(live);
      if (process.platform !== 'win32') {
        expect(exitCode).toBe(0);
        expect(live.records().map((r) => r.msg)).toContain('shutting down');
      }
      await waitFor(
        () => portInUse(port),
        (inUse) => !inUse,
      );
    },
    SLOW,
  );
});
