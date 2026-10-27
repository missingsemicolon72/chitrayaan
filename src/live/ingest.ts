import { mkdirSync, rmSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import type { MinimalLogger } from '../lib/logger.js';
import { buildLiveHlsArgs } from '../lib/packaging/index.js';
import {
  RtmpListener,
  type EndedSession,
  type ListenerOutput,
  type LiveSession,
} from '../lib/rtmp/index.js';
import type { ObjectStorage } from '../lib/storage/index.js';
import { LiveMirror } from './mirror.js';

/**
 * - `idle`: no stream to serve; nothing listens on the RTMP port.
 * - `listening`, `live`, `restarting`: the RTMP listener's states while serving a stream.
 * - `ending`: the publisher has gone and the stream's last segments are being published.
 */
export type IngestState = 'idle' | 'listening' | 'live' | 'restarting' | 'ending';

export interface IngestStatus {
  state: IngestState;
  streamId: string | null;
  /** Why the RTMP listener cannot listen, while that is the case. */
  error: string | null;
}

export interface LiveIngestHooks {
  /** The stream's publisher connected. */
  started?: (streamId: string, session: LiveSession) => void | Promise<void>;
  /**
   * The stream is over and its final state is in storage (or could not be put there). Runs
   * after `started` has settled, and before the ingest can serve another stream.
   */
  ended?: (streamId: string, session: EndedSession) => void | Promise<void>;
}

export interface LiveIngestOptions {
  ffmpegPath: string;
  host: string;
  port: number;
  streamKey: string;
  storage: ObjectStorage;
  /** Scratch directory owned by this process; each stream gets a directory inside it. */
  workRoot: string;
  logger: MinimalLogger;
  hooks?: LiveIngestHooks;
  /** Passed to the listener (tests shorten them). */
  idleTimeoutSeconds?: number;
  rearmSeconds?: number;
  /** Passed to each stream's mirror. */
  pollMs?: number;
}

/**
 * Live ingest for one stream at a time. `arm()` starts an RTMP listener for a stream; the
 * listener transcodes the stream's publisher to one HLS rung in a work directory, and a mirror
 * copies the result to storage, from where the API serves it under
 * `/api/live/<stream id>/live.m3u8`. A stream is one publish: when the publisher leaves, the
 * stream is over and the port closes until the next stream is armed.
 *
 * FFmpeg needs its output directory to exist before a publisher arrives, so each FFmpeg the
 * listener starts gets the stream's directory freshly made; one that never got a publisher (it
 * re-armed, or the publisher was rejected) has it removed and made again.
 */
export class LiveIngest {
  private listener: RtmpListener | null = null;
  private streamId: string | null = null;
  /** The directory prepared for the FFmpeg waiting for a publisher, until the stream claims it. */
  private armedDir: string | null = null;
  private mirror: LiveMirror | null = null;
  /** The `started` hook of the current stream, which `ended` waits for. */
  private started: Promise<void> = Promise.resolve();
  /** Publishing the end of the current stream. */
  private finishing: Promise<void> | null = null;
  private disarming: Promise<void> | null = null;

  constructor(private readonly options: LiveIngestOptions) {}

  /** The stream being served (listened for, live, or having its end published), if any. */
  get currentStreamId(): string | null {
    return this.streamId;
  }

  status(): IngestStatus {
    if (this.listener === null) return { state: 'idle', streamId: null, error: null };
    const { state, lastError } = this.listener.status();
    return {
      state: state === 'stopped' ? 'ending' : state,
      streamId: this.streamId,
      error: lastError,
    };
  }

  /** Clear what a previous run left behind. Call once, before serving any stream. */
  async start(): Promise<void> {
    // This process is the only live ingest, so anything here was left by a previous run that
    // did not shut down cleanly. An FFmpeg orphaned by that run may still be writing here and,
    // on Windows, holding its files open; new streams get new directories, so carry on.
    try {
      await rm(this.options.workRoot, { recursive: true, force: true });
    } catch (err) {
      this.options.logger.warn(
        { err, workRoot: this.options.workRoot },
        'could not clear the live work dir a previous run left; continuing',
      );
    }
    await mkdir(this.options.workRoot, { recursive: true });
  }

  /** Listen for the publisher of `streamId`. Throws while another stream is being served. */
  arm(streamId: string): void {
    if (this.streamId !== null) throw new Error(`already serving live stream ${this.streamId}`);
    const { options } = this;
    const listener = new RtmpListener({
      ffmpegPath: options.ffmpegPath,
      host: options.host,
      port: options.port,
      streamKey: options.streamKey,
      logger: options.logger,
      ...(options.idleTimeoutSeconds !== undefined
        ? { idleTimeoutSeconds: options.idleTimeoutSeconds }
        : {}),
      ...(options.rearmSeconds !== undefined ? { rearmSeconds: options.rearmSeconds } : {}),
      once: true,
      sessionId: () => streamId,
      output: () => this.prepare(streamId),
    });
    listener.on('session-started', (session) => this.onSessionStarted(streamId, session));
    listener.on('session-ended', (session) => this.onSessionEnded(listener, streamId, session));
    this.listener = listener;
    this.streamId = streamId;
    this.started = Promise.resolve();
    listener.start();
  }

  /**
   * Stop serving the current stream. A live one ends (reason `stopped`) and its final state is
   * published before this resolves.
   */
  disarm(): Promise<void> {
    this.disarming ??= this.release().finally(() => {
      this.disarming = null;
    });
    return this.disarming;
  }

  /** Stop serving, as for shutdown. */
  stop(): Promise<void> {
    return this.disarm();
  }

  private async release(): Promise<void> {
    const listener = this.listener;
    if (listener !== null) await listener.stop();
    // A session that was live emitted its end while the listener stopped.
    if (this.finishing !== null) await this.finishing;
    if (this.listener === listener) this.forget();
  }

  private forget(): void {
    this.discardArmedDir();
    this.listener = null;
    this.streamId = null;
  }

  private workDir(streamId: string): string {
    return path.join(this.options.workRoot, streamId);
  }

  /** Called by the listener right before each FFmpeg starts. */
  private prepare(streamId: string): ListenerOutput {
    this.discardArmedDir();
    const dir = this.workDir(streamId);
    mkdirSync(dir, { recursive: true });
    this.armedDir = dir;
    return { args: buildLiveHlsArgs(), cwd: dir };
  }

  private discardArmedDir(): void {
    if (this.armedDir === null) return;
    rmSync(this.armedDir, { recursive: true, force: true });
    this.armedDir = null;
  }

  private onSessionStarted(streamId: string, session: LiveSession): void {
    const { options } = this;
    const dir = this.workDir(streamId);
    if (this.armedDir === dir) this.armedDir = null;
    this.mirror = new LiveMirror({
      streamId,
      dir,
      storage: options.storage,
      logger: options.logger,
      ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
    });
    this.mirror.start();
    this.started = Promise.resolve()
      .then(() => options.hooks?.started?.(streamId, session))
      .catch((err: unknown) =>
        options.logger.error({ err, streamId }, 'live stream start hook failed'),
      );
  }

  private onSessionEnded(listener: RtmpListener, streamId: string, session: EndedSession): void {
    const { logger, hooks } = this.options;
    const mirror = this.mirror;
    this.mirror = null;
    const dir = this.workDir(streamId);
    this.finishing = (async () => {
      if (mirror !== null) {
        try {
          await mirror.finish();
          logger.info({ streamId }, 'live stream published in full');
        } catch (err) {
          logger.error({ err, streamId }, 'could not publish the end of a live stream');
        }
      }
      await rm(dir, { recursive: true, force: true }).catch((err: unknown) =>
        logger.warn({ err, streamId }, 'could not remove a live stream work dir'),
      );
      await this.started;
      try {
        await hooks?.ended?.(streamId, session);
      } catch (err) {
        logger.error({ err, streamId }, 'live stream end hook failed');
      }
    })().finally(() => {
      this.finishing = null;
      if (this.listener === listener) this.forget();
    });
  }
}
