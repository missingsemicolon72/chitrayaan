import { spawn } from 'node:child_process';
import net from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import type { MinimalLogger } from '../../src/lib/logger.js';
import {
  buildListenerArgs,
  DISCARD_OUTPUT,
  RtmpListener,
  type EndedSession,
  type ListenerState,
  type LiveSession,
  type RejectReason,
  type RtmpListenerOptions,
} from '../../src/lib/rtmp/index.js';
import { FFMPEG_PATH, ffmpegAvailable } from '../helpers/ffmpeg.js';
import { freePort, listenerReady, portInUse, publish, type Publisher } from '../helpers/rtmp.js';
import { waitFor } from '../helpers/wait.js';

const FFMPEG = await ffmpegAvailable();
const STREAM_KEY = 'test-stream-key-0123456789';
const SLOW = 40_000;

/** A logger that keeps every call, so tests can check what reached the log. */
function captureLogger(): { logger: MinimalLogger; lines: string[] } {
  const lines: string[] = [];
  const record =
    (level: string) =>
    (...args: unknown[]) => {
      lines.push(`${level} ${JSON.stringify(args)}`);
    };
  const logger: MinimalLogger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  };
  return { logger, lines };
}

interface Recorded {
  started: LiveSession[];
  ended: EndedSession[];
  rejected: RejectReason[];
  states: ListenerState[];
}

function record(listener: RtmpListener): Recorded {
  const events: Recorded = { started: [], ended: [], rejected: [], states: [] };
  listener.on('session-started', (session) => events.started.push(session));
  listener.on('session-ended', (session) => events.ended.push(session));
  listener.on('rejected', (reason) => events.rejected.push(reason));
  listener.on('state', (state) => events.states.push(state));
  return events;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!FFMPEG)('RtmpListener (FFmpeg RTMP ingest)', () => {
  const listeners: RtmpListener[] = [];
  const publishers: Publisher[] = [];
  const cleanups: (() => Promise<void> | void)[] = [];

  async function startListener(overrides: Partial<RtmpListenerOptions> = {}) {
    const { logger, lines } = captureLogger();
    const port = await freePort();
    const listener = new RtmpListener({
      ffmpegPath: FFMPEG_PATH,
      host: '127.0.0.1',
      port,
      streamKey: STREAM_KEY,
      logger,
      idleTimeoutSeconds: 2,
      ...overrides,
    });
    listeners.push(listener);
    const events = record(listener);
    listener.start();
    return { listener, events, logs: lines, port: overrides.port ?? port };
  }

  function startPublisher(...args: Parameters<typeof publish>): Publisher {
    const publisher = publish(...args);
    publishers.push(publisher);
    return publisher;
  }

  afterEach(async () => {
    for (const publisher of publishers.splice(0)) publisher.kill();
    await Promise.all(listeners.splice(0).map((listener) => listener.stop()));
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it(
    'accepts a publisher with the right key, describes its stream, and re-arms after it ends',
    async () => {
      const { listener, events, port } = await startListener();
      await listenerReady(listener);

      const first = startPublisher({ port, streamKey: STREAM_KEY, seconds: 3 });
      await waitFor(
        async () => listener.status(),
        (status) => status.state === 'live' && (status.session?.receivedSeconds ?? 0) > 0.5,
      );
      expect(events.started).toHaveLength(1);
      expect(events.started[0]?.input).toEqual({
        video: { codec: 'h264', width: 640, height: 360, fps: 30 },
        audio: { codec: 'aac', sampleRate: 48000, channels: 'stereo' },
      });

      expect((await first.done).exitCode).toBe(0);
      await waitFor(
        async () => events.ended.length,
        (n) => n === 1,
      );
      const ended = events.ended[0];
      expect(ended?.reason).toBe('publisher-disconnected');
      expect(ended?.error).toBeNull();
      expect(ended?.receivedSeconds).toBeGreaterThan(2.5);
      expect(ended?.frames).toBeGreaterThan(75);

      // FFmpeg's listener takes one connection per process, so the next stream needs a new one.
      await listenerReady(listener);
      const second = startPublisher({ port, streamKey: STREAM_KEY, seconds: 1 });
      expect((await second.done).exitCode).toBe(0);
      await waitFor(
        async () => events.ended.length,
        (n) => n === 2,
      );
      expect(events.started).toHaveLength(2);
      expect(events.started[1]?.id).not.toBe(events.started[0]?.id);
      expect(events.rejected).toEqual([]);
    },
    SLOW,
  );

  it(
    'turns away a wrong stream key without logging either key, then accepts the right one',
    async () => {
      const { listener, events, logs, port } = await startListener();
      await listenerReady(listener);

      const wrongKey = 'not-the-key-but-close-0123';
      const intruder = startPublisher({ port, streamKey: wrongKey, seconds: 5 });
      const { exitCode } = await intruder.done;
      expect(exitCode).not.toBe(0);
      expect(events.rejected).toEqual(['stream-key']);
      expect(events.started).toEqual([]);

      await listenerReady(listener);
      const owner = startPublisher({ port, streamKey: STREAM_KEY, seconds: 1 });
      expect((await owner.done).exitCode).toBe(0);
      expect(events.started).toHaveLength(1);

      const logged = logs.join('\n');
      expect(logged).toContain('wrong stream key');
      expect(logged).not.toContain(STREAM_KEY);
      expect(logged).not.toContain(wrongKey);
    },
    SLOW,
  );

  it(
    'turns away a publisher using the wrong application name',
    async () => {
      const { listener, events, port } = await startListener();
      await listenerReady(listener);

      const publisher = startPublisher({ port, streamKey: STREAM_KEY, app: 'other', seconds: 5 });
      expect((await publisher.done).exitCode).not.toBe(0);
      expect(events.rejected).toEqual(['app']);
      expect(events.started).toEqual([]);
    },
    SLOW,
  );

  it(
    'refuses a second publisher while a stream is live, without disturbing the first',
    async () => {
      const { listener, events, port } = await startListener();
      await listenerReady(listener);

      const first = startPublisher({ port, streamKey: STREAM_KEY, seconds: 6 });
      await waitFor(
        async () => listener.status().state,
        (state) => state === 'live',
      );
      // Probed with a bare TCP connect: FFmpeg as a client takes seconds to notice a refusal on
      // Windows, which says nothing about the server.
      const refusal = await new Promise<string>((resolve) => {
        const socket = net.connect(port, '127.0.0.1', () => {
          socket.destroy();
          resolve('connected');
        });
        socket.on('error', (err: NodeJS.ErrnoException) => resolve(err.code ?? err.message));
      });
      expect(refusal).toBe('ECONNREFUSED');
      expect(listener.status().state).toBe('live');

      expect((await first.done).exitCode).toBe(0);
      await waitFor(
        async () => events.ended.length,
        (n) => n === 1,
      );
      expect(events.started).toHaveLength(1);
      expect(events.ended[0]?.reason).toBe('publisher-disconnected');
      expect(events.ended[0]?.receivedSeconds).toBeGreaterThan(5);
    },
    SLOW,
  );

  it(
    'drops a connection that never speaks, so it cannot hold the only slot',
    async () => {
      const { listener, events, port } = await startListener();
      await listenerReady(listener);

      const startedAt = Date.now();
      const closedByServer = await new Promise<boolean>((resolve) => {
        const socket = net.connect(port, '127.0.0.1');
        socket.on('error', () => undefined);
        socket.on('close', () => resolve(true));
        setTimeout(() => {
          socket.destroy();
          resolve(false);
        }, 15_000);
      });
      expect(closedByServer).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(10_000);

      await listenerReady(listener);
      const publisher = startPublisher({ port, streamKey: STREAM_KEY, seconds: 1 });
      expect((await publisher.done).exitCode).toBe(0);
      expect(events.started).toHaveLength(1);
    },
    SLOW,
  );

  it(
    'replaces an idle FFmpeg on schedule without calling it a failure',
    async () => {
      const { listener, events, logs, port } = await startListener({ rearmSeconds: 2 });
      const rearms = () => logs.filter((line) => line.includes('re-arming')).length;

      await waitFor(
        async () => rearms(),
        (n) => n >= 2,
        { timeoutMs: 15_000 },
      );
      expect(listener.status()).toMatchObject({ state: 'listening', lastError: null });
      expect(events.states).not.toContain('restarting');

      // Just after a replacement, so the connection lands well inside the next listener's wait.
      const before = rearms();
      await waitFor(
        async () => rearms(),
        (n) => n > before,
        { timeoutMs: 10_000 },
      );
      await listenerReady(listener);
      const publisher = startPublisher({ port, streamKey: STREAM_KEY, seconds: 3 });
      expect((await publisher.done).exitCode).toBe(0);
      // A live stream is not cut off by the re-arm period: that only bounds the idle wait.
      await waitFor(
        async () => events.ended.length,
        (n) => n === 1,
      );
      expect(events.ended[0]?.reason).toBe('publisher-disconnected');
      expect(events.ended[0]?.receivedSeconds).toBeGreaterThan(2.5);
    },
    SLOW,
  );

  it('an FFmpeg listener left behind by a killed live process gives up on its own', async () => {
    const port = await freePort();
    // What an orphan is: the listener's own FFmpeg with nobody watching it.
    const orphan = spawn(
      FFMPEG_PATH,
      buildListenerArgs({
        host: '127.0.0.1',
        port,
        streamKey: STREAM_KEY,
        idleTimeoutSeconds: 2,
        rearmSeconds: 2,
        output: DISCARD_OUTPUT,
      }),
      { stdio: 'ignore', windowsHide: true },
    );
    const startedAt = Date.now();
    const exitedAlone = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        orphan.kill('SIGKILL');
        resolve(false);
      }, 10_000);
      orphan.once('close', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    expect(exitedAlone).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(6_000);
    expect(await portInUse(port)).toBe(false);
  });

  it(
    'ends the session when a publisher stalls mid-stream, and listens again',
    async () => {
      const { listener, events, port } = await startListener();
      await listenerReady(listener);

      // A relay that forwards the stream, then stops forwarding without closing anything: what a
      // publisher behind a dead network link looks like from the server.
      let stalled = false;
      const relay = net.createServer((client) => {
        const upstream = net.connect(port, '127.0.0.1');
        client.on('data', (data) => {
          if (!stalled) upstream.write(data);
        });
        upstream.on('data', (data) => {
          if (!stalled) client.write(data);
        });
        client.on('error', () => undefined);
        upstream.on('error', () => undefined);
        cleanups.push(() => {
          client.destroy();
          upstream.destroy();
        });
      });
      await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
      cleanups.push(() => new Promise<void>((resolve) => relay.close(() => resolve())));
      const relayPort = (relay.address() as net.AddressInfo).port;

      startPublisher({ port: relayPort, streamKey: STREAM_KEY, seconds: 30 });
      await waitFor(
        async () => listener.status().session?.receivedSeconds ?? 0,
        (seconds) => seconds > 1,
      );
      stalled = true;
      const stalledAt = Date.now();

      await waitFor(
        async () => events.ended.length,
        (n) => n === 1,
        { timeoutMs: 15_000 },
      );
      expect(Date.now() - stalledAt).toBeLessThan(10_000);
      expect(events.ended[0]?.reason).toBe('publisher-disconnected');
      await waitFor(
        async () => listener.status().state,
        (state) => state === 'listening',
      );
    },
    SLOW,
  );

  it(
    'backs off while the port is taken, says why, and recovers once it is free',
    async () => {
      const port = await freePort();
      const blocker = net.createServer();
      await new Promise<void>((resolve) => blocker.listen(port, '127.0.0.1', resolve));

      const { listener, events, logs } = await startListener({ port });
      const failing = await waitFor(
        async () => listener.status(),
        (status) => status.state === 'restarting' && status.lastError !== null,
      );
      expect(failing.lastError).toMatch(new RegExp(`port ${port}`));

      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      await sleep(1_500);
      await listenerReady(listener);
      const publisher = startPublisher({ port, streamKey: STREAM_KEY, seconds: 1 });
      expect((await publisher.done).exitCode).toBe(0);
      expect(events.started).toHaveLength(1);
      // The crash loop is logged once, not once per retry.
      expect(logs.filter((line) => line.includes('retrying with backoff'))).toHaveLength(1);
    },
    SLOW,
  );

  it(
    'stop() ends a live stream and frees the port',
    async () => {
      const { listener, events, port } = await startListener();
      await listenerReady(listener);

      const publisher = startPublisher({ port, streamKey: STREAM_KEY, seconds: 20 });
      await waitFor(
        async () => listener.status().state,
        (state) => state === 'live',
      );
      await listener.stop();

      expect(listener.status()).toMatchObject({ state: 'stopped', session: null });
      expect(events.ended.map((session) => session.reason)).toEqual(['stopped']);
      expect(await portInUse(port)).toBe(false);
      const { exitCode } = await publisher.done;
      expect(exitCode).not.toBe(0);
    },
    SLOW,
  );

  it(
    'start() during a stop() ends with one listener running, not a stopped one',
    async () => {
      const { listener, events, port } = await startListener();
      await listenerReady(listener);

      const stopping = listener.stop();
      listener.start();
      await stopping;

      expect(listener.status().state).toBe('listening');
      await listenerReady(listener);
      const publisher = startPublisher({ port, streamKey: STREAM_KEY, seconds: 1 });
      expect((await publisher.done).exitCode).toBe(0);
      expect(events.started).toHaveLength(1);
    },
    SLOW,
  );

  it('reports a missing FFmpeg binary instead of throwing', async () => {
    const { listener } = await startListener({ ffmpegPath: 'chitrayaan-no-such-ffmpeg' });
    const status = await waitFor(
      async () => listener.status(),
      (s) => s.lastError !== null,
    );
    expect(status.lastError).toMatch(/could not start ffmpeg/);
    expect(status.state).toBe('restarting');
  });
});
