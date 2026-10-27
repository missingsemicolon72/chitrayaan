import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { createDatabase, type Database } from '../../src/lib/db/index.js';
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
  /** Its working directory; its storage and scratch space live inside it. */
  cwd: string;
  /** Everything it wrote to stdout and stderr so far. */
  output: () => string;
  /** Its log records so far, parsed from stdout. */
  records: () => LogRecord[];
  exited: Promise<number | null>;
}

const running: LiveProcess[] = [];
const scratchDirs: string[] = [];
const databases: Database[] = [];

/**
 * Run the real entrypoint the way `npm run dev:live` does. It runs from an empty directory, so a
 * developer's `.env` cannot leak in, keeps its database, storage and scratch space there too (its
 * work root is wiped at startup), and logs JSON (NODE_ENV=production) so tests can read it. Pass
 * the `cwd` of an earlier run to restart it on the same data.
 */
async function runLive(env: Record<string, string>, reuseCwd?: string): Promise<LiveProcess> {
  const cwd = reuseCwd ?? (await mkdtemp(path.join(os.tmpdir(), 'chitrayaan-live-')));
  if (reuseCwd === undefined) scratchDirs.push(cwd);
  const child = spawn(process.execPath, ['--import', TSX_LOADER, ENTRYPOINT], {
    cwd,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      LOG_LEVEL: 'info',
      API_KEY: 'a-sufficiently-long-test-key',
      HOST: '127.0.0.1',
      FFMPEG_PATH,
      DB_BACKEND: 'sqlite',
      SQLITE_PATH: path.join(cwd, 'db.sqlite'),
      STORAGE_BACKEND: 'local',
      LOCAL_STORAGE_PATH: path.join(cwd, 'storage'),
      WORK_DIR: path.join(cwd, 'work'),
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
    cwd,
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

/** The live process's database, opened as the API would open it. */
async function openDatabase(live: LiveProcess): Promise<Database> {
  const db = await createDatabase({
    DB_BACKEND: 'sqlite',
    SQLITE_PATH: path.join(live.cwd, 'db.sqlite'),
  });
  databases.push(db);
  return db;
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
    await Promise.all(databases.splice(0).map((db) => db.close()));
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
    'serves a stream created in the database: listens, publishes its live HLS, ends it, deletes it, and frees the port',
    async () => {
      const port = await freePort();
      const live = await runLive({
        RTMP_STREAM_KEY: STREAM_KEY,
        RTMP_LISTEN_PORT: String(port),
        LIVE_CLEANUP_DELAY_SECONDS: '1',
      });
      expect(await waitForLog(live, 'live ingest ready')).toMatchObject({
        name: 'live',
        db: 'sqlite',
        port,
      });
      const db = await openDatabase(live);
      expect(await db.liveIngest.get()).toMatchObject({ state: 'idle', error: null });
      // No stream, no listener.
      expect(await portInUse(port)).toBe(false);

      // What POST /api/live/streams does.
      const stream = await db.liveStreams.create();
      const listening = await waitForLog(live, 'RTMP ingest started');
      expect(listening).toMatchObject({ port, host: '127.0.0.1' });
      // FFmpeg logs nothing once it is bound, and probing would use up its single accept.
      await new Promise((resolve) => setTimeout(resolve, 750));

      const publisher = publish({ port, streamKey: STREAM_KEY, seconds: 3 });
      const connected = await waitForLog(live, 'RTMP publisher connected');
      expect(connected).toMatchObject({
        sessionId: stream.id,
        input: { video: { codec: 'h264', width: 640, height: 360 } },
      });
      const received = await waitForLog(live, 'RTMP stream ended');
      expect(received).toMatchObject({ sessionId: stream.id, reason: 'publisher-disconnected' });
      expect(received.receivedSeconds).toBeGreaterThan(2.5);
      expect((await publisher.done).exitCode).toBe(0);
      const published = await waitForLog(live, 'live playlist published');
      expect(published.playlist).toBe(`/api/live/${stream.id}/live.m3u8`);
      await waitForLog(live, 'live stream published in full');
      expect(await waitForLog(live, 'live stream ended')).toMatchObject({
        streamId: stream.id,
        reason: 'publisher-disconnected',
      });
      const playlist = await readFile(
        path.join(live.cwd, 'storage', 'live', stream.id, 'live.m3u8'),
        'utf8',
      );
      expect(playlist).toContain('#EXT-X-MAP:URI="init.mp4"');
      expect(playlist).toContain('#EXT-X-ENDLIST');
      expect(await db.liveStreams.get(stream.id)).toMatchObject({
        status: 'ended',
        endReason: 'publisher-disconnected',
      });
      // One publish per stream: the port closes with it.
      await waitFor(
        () => portInUse(port),
        (inUse) => !inUse,
      );

      // A second later, its files go.
      expect(await waitForLog(live, 'live stream files deleted')).toMatchObject({
        streamId: stream.id,
      });
      expect((await db.liveStreams.get(stream.id))?.cleanedAt).not.toBeNull();
      expect(existsSync(path.join(live.cwd, 'storage', 'live', stream.id))).toBe(false);
      expect(live.output()).not.toContain(STREAM_KEY);

      const exitCode = await stopLive(live);
      if (process.platform !== 'win32') {
        expect(exitCode).toBe(0);
        expect(live.records().map((r) => r.msg)).toContain('shutting down');
        expect((await db.liveIngest.get())?.state).toBe('offline');
      }
    },
    SLOW,
  );

  it(
    'ends a stream whose live process went away mid-stream as interrupted, closing its playlist',
    async () => {
      const port = await freePort();
      const env = { RTMP_STREAM_KEY: STREAM_KEY, RTMP_LISTEN_PORT: String(port) };
      const first = await runLive(env);
      await waitForLog(first, 'live ingest ready');
      const db = await openDatabase(first);
      const stream = await db.liveStreams.create();
      await waitForLog(first, 'RTMP ingest started');
      await new Promise((resolve) => setTimeout(resolve, 750));
      const publisher = publish({ port, streamKey: STREAM_KEY, seconds: 30 });
      await waitForLog(first, 'live playlist published', 20_000);
      expect((await db.liveStreams.get(stream.id))?.status).toBe('live');

      // Killed outright on Windows (no SIGTERM there), so it cannot close the stream itself;
      // elsewhere SIGTERM lets it do so on the way out. Either way the stream ends interrupted.
      await stopLive(first);
      publisher.kill();
      const second = await runLive(env, first.cwd);
      await waitForLog(second, 'live ingest ready');
      const ended = await waitFor(
        () => db.liveStreams.get(stream.id),
        (s) => s?.status === 'ended',
      );
      expect(ended?.endReason).toBe('interrupted');
      const playlist = await readFile(
        path.join(first.cwd, 'storage', 'live', stream.id, 'live.m3u8'),
        'utf8',
      );
      expect(playlist).toContain('#EXT-X-ENDLIST');
    },
    SLOW,
  );
});
