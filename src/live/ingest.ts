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

export interface LiveIngestOptions {
  ffmpegPath: string;
  host: string;
  port: number;
  streamKey: string;
  storage: ObjectStorage;
  /** Scratch directory owned by this process; each session gets a directory inside it. */
  workRoot: string;
  logger: MinimalLogger;
  /** Passed to the listener (tests shorten them). */
  idleTimeoutSeconds?: number;
  rearmSeconds?: number;
  /** Passed to each session's mirror. */
  pollMs?: number;
}

/**
 * Live ingest: the RTMP listener transcodes each accepted stream to one HLS rung in a work
 * directory, and a mirror per session copies the result to storage, from where the API serves
 * it under `/api/live/<session id>/live.m3u8`.
 *
 * Every FFmpeg the listener starts gets a fresh directory named by the session id it would
 * have, because FFmpeg needs its output directory to exist before a publisher arrives. One that
 * never gets a publisher (it re-armed, or the publisher was rejected) has its directory removed
 * when the next FFmpeg starts.
 */
export class LiveIngest {
  readonly listener: RtmpListener;
  /** The directory prepared for the FFmpeg waiting for a publisher, until a session claims it. */
  private armedDir: string | null = null;
  private readonly mirrors = new Map<string, LiveMirror>();
  private readonly finishing = new Set<Promise<void>>();

  constructor(private readonly options: LiveIngestOptions) {
    this.listener = new RtmpListener({
      ffmpegPath: options.ffmpegPath,
      host: options.host,
      port: options.port,
      streamKey: options.streamKey,
      logger: options.logger,
      ...(options.idleTimeoutSeconds !== undefined
        ? { idleTimeoutSeconds: options.idleTimeoutSeconds }
        : {}),
      ...(options.rearmSeconds !== undefined ? { rearmSeconds: options.rearmSeconds } : {}),
      output: (sessionId) => this.prepare(sessionId),
    });
    this.listener.on('session-started', (session) => this.onSessionStarted(session));
    this.listener.on('session-ended', (session) => this.onSessionEnded(session));
  }

  /** Start accepting publishers. */
  async start(): Promise<void> {
    // This process is the only live ingest, so anything here was left by a previous run that
    // did not shut down cleanly.
    await rm(this.options.workRoot, { recursive: true, force: true });
    await mkdir(this.options.workRoot, { recursive: true });
    this.listener.start();
  }

  /** Stop accepting publishers, end any live stream, and publish its final state. */
  async stop(): Promise<void> {
    await this.listener.stop();
    await Promise.all(this.finishing);
    this.discardArmedDir();
  }

  private sessionDir(sessionId: string): string {
    return path.join(this.options.workRoot, sessionId);
  }

  /** Called by the listener right before each FFmpeg starts. */
  private prepare(sessionId: string): ListenerOutput {
    this.discardArmedDir();
    const dir = this.sessionDir(sessionId);
    mkdirSync(dir, { recursive: true });
    this.armedDir = dir;
    return { args: buildLiveHlsArgs(), cwd: dir };
  }

  private discardArmedDir(): void {
    if (this.armedDir === null) return;
    rmSync(this.armedDir, { recursive: true, force: true });
    this.armedDir = null;
  }

  private onSessionStarted(session: LiveSession): void {
    const dir = this.sessionDir(session.id);
    if (this.armedDir === dir) this.armedDir = null;
    const mirror = new LiveMirror({
      sessionId: session.id,
      dir,
      storage: this.options.storage,
      logger: this.options.logger,
      ...(this.options.pollMs !== undefined ? { pollMs: this.options.pollMs } : {}),
    });
    this.mirrors.set(session.id, mirror);
    mirror.start();
  }

  private onSessionEnded(session: EndedSession): void {
    const mirror = this.mirrors.get(session.id);
    if (!mirror) return;
    this.mirrors.delete(session.id);
    const { logger } = this.options;
    const done = mirror
      .finish()
      .then(
        () => logger.info({ sessionId: session.id }, 'live session published in full'),
        (err: unknown) =>
          logger.error(
            { err, sessionId: session.id },
            'could not publish the end of a live session',
          ),
      )
      .then(() => rm(this.sessionDir(session.id), { recursive: true, force: true }))
      .catch((err: unknown) =>
        logger.warn({ err, sessionId: session.id }, 'could not remove a live session work dir'),
      )
      .finally(() => this.finishing.delete(done));
    this.finishing.add(done);
  }
}
