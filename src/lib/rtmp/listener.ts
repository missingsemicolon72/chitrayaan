import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';

import type { MinimalLogger } from '../logger.js';
import { parseProgressBlock, TailBuffer } from '../transcode/index.js';
import { buildListenerArgs, DISCARD_OUTPUT, RTMP_APP } from './args.js';
import { BEHIND_RATIO, CAUGHT_UP_RATIO, RealtimeMonitor } from './realtime.js';
import { ListenerOutputParser, redact, type LiveInputInfo, type RejectReason } from './stderr.js';

/**
 * - `listening`: FFmpeg is waiting for a publisher.
 * - `live`: a publisher passed the key check and its stream is arriving.
 * - `restarting`: between listeners, after a failure or a burst of rejected connections.
 */
export type ListenerState = 'stopped' | 'listening' | 'live' | 'restarting';

export interface LiveSession {
  id: string;
  startedAt: Date;
  input: LiveInputInfo;
  /** Media time received so far, in seconds. */
  receivedSeconds: number;
  /** Video frames received so far. */
  frames: number;
}

/**
 * - `publisher-disconnected`: the publisher stopped, or went silent for longer than the idle
 *   timeout.
 * - `stopped`: `stop()` was called mid-stream.
 * - `failed`: FFmpeg exited with an error.
 */
export type SessionEndReason = 'publisher-disconnected' | 'stopped' | 'failed';

export interface EndedSession extends LiveSession {
  endedAt: Date;
  reason: SessionEndReason;
  /** The end of FFmpeg's output when the session failed, with the stream key redacted. */
  error: string | null;
}

export interface RtmpListenerStatus {
  state: ListenerState;
  port: number;
  session: LiveSession | null;
  /** Why the last listener could not be started, while that is still the situation. */
  lastError: string | null;
}

interface RtmpListenerEvents {
  state: [state: ListenerState];
  'session-started': [session: LiveSession];
  'session-ended': [session: EndedSession];
  rejected: [reason: RejectReason];
}

export interface RtmpListenerOptions {
  ffmpegPath: string;
  /** Interface to bind; `0.0.0.0` accepts publishers from other machines. */
  host: string;
  port: number;
  streamKey: string;
  logger: MinimalLogger;
  /** Silence, in seconds, after which a publisher is dropped. Defaults to 10. */
  idleTimeoutSeconds?: number;
  /**
   * Seconds each FFmpeg waits for a publisher before a fresh one replaces it. Defaults to 30,
   * which is also the longest an orphaned FFmpeg can hold the port after its parent is killed.
   */
  rearmSeconds?: number;
  /**
   * What FFmpeg does with an accepted stream, asked for each new FFmpeg right before it starts.
   * `sessionId` becomes the id of the session if that FFmpeg accepts a publisher, so the output
   * can be put where the session will look for it. Defaults to discarding the stream.
   */
  output?: (sessionId: string) => ListenerOutput;
  /** The id the next FFmpeg's session would have. Defaults to a fresh random UUID each time. */
  sessionId?: () => string;
  /**
   * Serve one session only: once it ends, stop instead of listening for the next publisher.
   * Rejected publishers and connections that never publish do not count.
   */
  once?: boolean;
}

export interface ListenerOutput {
  /** Output arguments: everything after the input. */
  args: readonly string[];
  /** FFmpeg's working directory, against which relative output paths resolve. */
  cwd?: string;
}

/** A listener that dies sooner than this after starting counts towards backing off. */
export const FAST_EXIT_MS = 5_000;
export const MAX_RETRY_DELAY_MS = 15_000;

/**
 * How long to wait before the next listener after `failures` consecutive fast exits: nothing
 * after the first, then doubling from 250 ms to a 15 s ceiling. A crash loop (port taken,
 * FFmpeg missing) or a client hammering the port therefore slows down instead of spinning.
 */
export function retryDelayMs(failures: number): number {
  if (failures <= 1) return 0;
  return Math.min(MAX_RETRY_DELAY_MS, 250 * 2 ** (failures - 2));
}

/** What one FFmpeg process saw, from spawn to exit. */
interface Attempt {
  /** Becomes the session id if this FFmpeg accepts a publisher. */
  id: string;
  child: ChildProcess;
  spawnedAt: number;
  session: LiveSession | null;
  rejected: RejectReason | null;
  /** No connection was accepted: the port could not be bound, or the wait timed out. */
  listenFailed: boolean;
  spawnError: Error | null;
  /** Set by `stop()`, so the exit is reported as a stop rather than a disconnect or failure. */
  stopRequested: boolean;
  stderr: TailBuffer;
  exited: Promise<void>;
  realtime: RealtimeMonitor;
  /** The stream was last reported as falling behind real time. */
  behind: boolean;
}

/**
 * Accepts one RTMP publisher at a time on a fixed port, using FFmpeg's own listener
 * (decision #8). FFmpeg accepts a single connection per process and closes its listening socket
 * once it has one, so a second publisher is refused while a stream is live; when the stream
 * ends, a fresh FFmpeg is spawned to accept the next one. An idle FFmpeg is also replaced every
 * `rearmSeconds`, so one orphaned by a killed live process cannot hold the port for long.
 *
 * FFmpeg does not enforce the stream key or the application name, it only warns about a
 * mismatch, so this class kills the process the moment either warning appears.
 */
export class RtmpListener extends EventEmitter<RtmpListenerEvents> {
  private readonly idleTimeoutSeconds: number;
  private readonly rearmSeconds: number;
  private readonly output: (sessionId: string) => ListenerOutput;
  private readonly nextSessionId: () => string;
  private running = false;
  private state: ListenerState = 'stopped';
  private attempt: Attempt | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private fastExits = 0;
  private lastError: string | null = null;
  /** The failure last written to the log, so a crash loop logs once rather than every retry. */
  private reportedError: string | null = null;

  constructor(private readonly options: RtmpListenerOptions) {
    super();
    this.idleTimeoutSeconds = options.idleTimeoutSeconds ?? 10;
    this.rearmSeconds = options.rearmSeconds ?? 30;
    this.output = options.output ?? (() => ({ args: DISCARD_OUTPUT }));
    this.nextSessionId = options.sessionId ?? (() => randomUUID());
  }

  /** Start accepting publishers. Does nothing if already started. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.options.logger.info(
      { port: this.options.port, host: this.options.host, app: RTMP_APP },
      `RTMP ingest started: publish to rtmp://<host>:${this.options.port}/${RTMP_APP} with the stream key`,
    );
    // After a quick stop() and start(), the previous FFmpeg may still be exiting; its exit
    // handler spawns the next listener once the port is free.
    if (this.attempt === null) this.spawnListener();
  }

  /** Stop listening, ending any live stream. Resolves once FFmpeg has exited and the port is free. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const attempt = this.attempt;
    if (attempt) {
      attempt.stopRequested = true;
      // SIGTERM lets FFmpeg finish what it was writing; SIGKILL if it does not take the hint.
      attempt.child.kill('SIGTERM');
      const force = setTimeout(() => attempt.child.kill('SIGKILL'), 3_000);
      await attempt.exited;
      clearTimeout(force);
    }
    // start() may have been called while FFmpeg was exiting, and a new listener be running.
    if (this.running) return;
    this.lastError = null;
    this.setState('stopped');
  }

  status(): RtmpListenerStatus {
    const session = this.attempt?.session;
    return {
      state: this.state,
      port: this.options.port,
      session: session ? { ...session } : null,
      lastError: this.lastError,
    };
  }

  private setState(state: ListenerState): void {
    if (state === this.state) return;
    this.state = state;
    this.emit('state', state);
  }

  private spawnListener(): void {
    this.retryTimer = null;
    const { ffmpegPath, host, port, streamKey } = this.options;
    const id = this.nextSessionId();
    let output: ListenerOutput;
    try {
      output = this.output(id);
    } catch (err) {
      this.lastError = `could not prepare the stream's output: ${(err as Error).message}`;
      this.rearm(false);
      return;
    }
    const child = spawn(
      ffmpegPath,
      buildListenerArgs({
        host,
        port,
        streamKey,
        idleTimeoutSeconds: this.idleTimeoutSeconds,
        rearmSeconds: this.rearmSeconds,
        output: output.args,
      }),
      { cwd: output.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let resolveExited: () => void = () => undefined;
    const attempt: Attempt = {
      id,
      child,
      spawnedAt: Date.now(),
      session: null,
      rejected: null,
      listenFailed: false,
      spawnError: null,
      stopRequested: false,
      stderr: new TailBuffer(20),
      exited: new Promise((resolve) => {
        resolveExited = resolve;
      }),
      realtime: new RealtimeMonitor(),
      behind: false,
    };
    this.attempt = attempt;
    this.lastError = null;
    this.setState('listening');

    const parser = new ListenerOutputParser();
    readline.createInterface({ input: child.stderr }).on('line', (raw) => {
      const line = redact(raw, streamKey);
      const event = parser.feed(line);
      // A rejection line names the key the publisher tried; keep it out of anything retained.
      attempt.stderr.push(`${event?.kind === 'rejected' ? '[publisher rejected]' : line}\n`);
      if (event === null) return;

      if (event.kind === 'rejected') {
        if (attempt.rejected === null && attempt.session === null) {
          attempt.rejected = event.reason;
          child.kill('SIGKILL');
        }
      } else if (event.kind === 'listen-failed') {
        attempt.listenFailed = true;
      } else if (attempt.rejected === null) {
        this.beginSession(attempt, event.info);
      }
    });

    let progress: Record<string, string> = {};
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      const eq = line.indexOf('=');
      if (eq === -1) return;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (key !== 'progress') {
        progress[key] = value;
        return;
      }
      const session = attempt.session;
      if (session) {
        session.receivedSeconds = parseProgressBlock(progress, undefined).outTimeSeconds;
        const frames = Number(progress.frame);
        if (Number.isFinite(frames)) session.frames = frames;
        this.checkRealtime(attempt, session);
      }
      progress = {};
    });

    child.once('error', (err) => {
      attempt.spawnError = err;
    });
    child.once('close', (code) => {
      this.onExit(attempt, code);
      resolveExited();
    });
  }

  private beginSession(attempt: Attempt, input: LiveInputInfo): void {
    const session: LiveSession = {
      id: attempt.id,
      startedAt: new Date(),
      input,
      receivedSeconds: 0,
      frames: 0,
    };
    attempt.session = session;
    this.fastExits = 0;
    this.setState('live');
    this.options.logger.info({ sessionId: session.id, input }, 'RTMP publisher connected');
    this.emit('session-started', { ...session });
  }

  /** Warn when a stream stops keeping up with real time, and say so when it recovers. */
  private checkRealtime(attempt: Attempt, session: LiveSession): void {
    const ratio = attempt.realtime.add(Date.now(), session.receivedSeconds);
    if (ratio === null) return;
    const details = { sessionId: session.id, realtime: Number(ratio.toFixed(2)) };
    if (!attempt.behind && ratio < BEHIND_RATIO) {
      attempt.behind = true;
      this.options.logger.warn(
        details,
        'live stream is falling behind real time: the publisher cannot send fast enough or this machine cannot encode fast enough',
      );
    } else if (attempt.behind && ratio >= CAUGHT_UP_RATIO) {
      attempt.behind = false;
      this.options.logger.info(details, 'live stream is keeping up with real time again');
    }
  }

  private onExit(attempt: Attempt, code: number | null): void {
    const { logger, port } = this.options;
    const livedMs = Date.now() - attempt.spawnedAt;
    // FFmpeg reports a timed-out wait exactly like a port it could not bind; a bind fails at
    // once, while a timeout takes the whole re-arm period.
    const rearmed = attempt.listenFailed && livedMs >= this.rearmSeconds * 500;

    if (attempt.session) {
      const reason: SessionEndReason = attempt.stopRequested
        ? 'stopped'
        : code === 0
          ? 'publisher-disconnected'
          : 'failed';
      const ended: EndedSession = {
        ...attempt.session,
        endedAt: new Date(),
        reason,
        error: reason === 'failed' ? attempt.stderr.toString() : null,
      };
      const summary = {
        sessionId: ended.id,
        reason,
        receivedSeconds: Number(ended.receivedSeconds.toFixed(2)),
        frames: ended.frames,
      };
      if (reason === 'failed')
        logger.error({ ...summary, error: ended.error }, 'RTMP stream failed');
      else logger.info(summary, 'RTMP stream ended');
      this.emit('session-ended', ended);
    } else if (attempt.stopRequested) {
      // Stopped while waiting: nothing to report.
    } else if (attempt.rejected) {
      logger.warn(
        { reason: attempt.rejected },
        attempt.rejected === 'stream-key'
          ? 'RTMP publisher rejected: wrong stream key'
          : `RTMP publisher rejected: wrong application, publish to /${RTMP_APP}`,
      );
      this.emit('rejected', attempt.rejected);
    } else if (attempt.spawnError) {
      this.lastError = `could not start ffmpeg: ${attempt.spawnError.message}`;
    } else if (rearmed) {
      logger.debug({ rearmSeconds: this.rearmSeconds }, 'no RTMP publisher yet; re-arming');
    } else if (attempt.listenFailed) {
      this.lastError = `cannot listen on port ${port}: it is in use or not permitted`;
    } else {
      // Connected but never published: a port scanner, a player trying to pull, a client that
      // went silent during the handshake.
      logger.debug({ exitCode: code }, 'RTMP connection closed before publishing');
    }

    this.attempt = null;
    if (attempt.session !== null && this.options.once === true) {
      // Its one session is over.
      this.running = false;
      this.lastError = null;
      this.setState('stopped');
      return;
    }
    const failedToListen = attempt.spawnError !== null || (attempt.listenFailed && !rearmed);
    this.rearm(
      attempt.session !== null ||
        attempt.stopRequested ||
        rearmed ||
        (!failedToListen && livedMs >= FAST_EXIT_MS),
    );
  }

  /**
   * Start the next FFmpeg: at once after a healthy run, with growing delays after consecutive
   * fast failures. Logs a failure once, however many times it repeats.
   */
  private rearm(healthy: boolean): void {
    if (!this.running) return;
    const { logger } = this.options;
    this.fastExits = healthy ? 0 : this.fastExits + 1;

    if (this.lastError === null) {
      this.reportedError = null;
    } else if (this.lastError !== this.reportedError) {
      this.reportedError = this.lastError;
      logger.error({ error: this.lastError }, 'RTMP listener failed; retrying with backoff');
    }

    const delay = retryDelayMs(this.fastExits);
    if (delay === 0) {
      this.spawnListener();
    } else {
      this.setState('restarting');
      this.retryTimer = setTimeout(() => this.spawnListener(), delay);
    }
  }
}
