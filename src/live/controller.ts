import type { Database, LiveEndReason, LiveStream } from '../lib/db/index.js';
import {
  LIVE_PLAYLIST,
  LIVE_PREFIX,
  liveKey,
  parseLivePlaylist,
  withEndList,
} from '../lib/packaging/index.js';
import type { EndedSession } from '../lib/rtmp/index.js';
import { contentTypeForKey, readStoredText } from '../lib/storage/index.js';
import { LiveIngest, type LiveIngestOptions } from './ingest.js';

export interface LiveControllerOptions extends Omit<LiveIngestOptions, 'hooks'> {
  db: Database;
  /** How long an ended stream's files stay in storage, so viewers can play to its end. */
  cleanupDelaySeconds: number;
  /** How often to look at the database for streams to start or stop. Defaults to 1 s. */
  checkMs?: number;
  /** How often to report this process's state even when it has not changed. Defaults to 5 s. */
  reportMs?: number;
}

/** A failing check is retried on the next one; this keeps a persistent failure's log readable. */
const ERROR_LOG_INTERVAL_MS = 30_000;

/**
 * Runs live streams as the database describes them. The API never talks to the live process
 * (decision #21): it creates and stops streams in the database, and this controller checks the
 * database every second and acts on what it finds:
 *
 * - a `waiting` stream: arm the ingest for it;
 * - a stop request, or the stream ended through the API before its publisher arrived: disarm;
 * - a `live` stream that nothing here serves: the live process that served it stopped or died
 *   mid-stream, so end it (`interrupted`) and mark its playlist as ended;
 * - an ended stream past its cleanup time: delete its files.
 *
 * It records what the ingest sees (publisher connected, stream ended), and reports its own
 * state, which also tells the API whether live ingest is running.
 */
export class LiveController {
  readonly ingest: LiveIngest;
  private readonly checkMs: number;
  private readonly reportMs: number;
  private running = false;
  /** Streams ending now ended because this process is shutting down. */
  private shuttingDown = false;
  private timer: NodeJS.Timeout | null = null;
  private checking: Promise<void> | null = null;
  private lastReport: { state: string; at: number } | null = null;
  private lastErrorLogAt = 0;

  constructor(private readonly options: LiveControllerOptions) {
    this.checkMs = options.checkMs ?? 1_000;
    this.reportMs = options.reportMs ?? 5_000;
    this.ingest = new LiveIngest({
      ...options,
      hooks: {
        started: (streamId) => this.onStarted(streamId),
        ended: (streamId, session) => this.onEnded(streamId, session),
      },
    });
  }

  /** Clear up after any previous run, then serve whatever the database says. */
  async start(): Promise<void> {
    await this.ingest.start();
    try {
      await this.sweepOrphans();
    } catch (err) {
      this.options.logger.warn({ err }, 'could not sweep leftover live files; continuing');
    }
    this.running = true;
    await this.check();
    this.schedule();
  }

  /**
   * Stop serving. A live stream ends as `interrupted`, with its final state published; a
   * waiting one stays waiting, for the next run to pick up.
   */
  async stop(): Promise<void> {
    this.running = false;
    this.shuttingDown = true;
    if (this.timer !== null) clearTimeout(this.timer);
    await this.checking;
    await this.ingest.stop();
    await this.options.db.liveIngest
      .report({ state: 'offline', error: null })
      .catch((err: unknown) =>
        this.options.logger.warn({ err }, 'could not report live ingest as offline'),
      );
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.checking = this.check().finally(() => {
        this.checking = null;
        this.schedule();
      });
    }, this.checkMs);
  }

  /** One pass. Each step is isolated, so a failing one never blocks the others. */
  private async check(): Promise<void> {
    for (const [step, what] of [
      [() => this.reconcile(), 'check live streams'],
      [() => this.cleanUp(), 'delete ended live streams'],
      [() => this.report(), 'report the live ingest state'],
    ] as const) {
      try {
        await step();
      } catch (err) {
        const now = Date.now();
        if (now - this.lastErrorLogAt >= ERROR_LOG_INTERVAL_MS) {
          this.lastErrorLogAt = now;
          this.options.logger.error({ err }, `could not ${what} (will keep trying)`);
        }
      }
    }
  }

  /** Bring the ingest in line with the active stream in the database. */
  private async reconcile(): Promise<void> {
    const { db, logger } = this.options;
    const active = await db.liveStreams.getActive();
    const serving = this.ingest.currentStreamId;

    if (serving !== null) {
      // Publishing its last segments; it records its own end when done.
      if (this.ingest.status().state === 'ending') return;
      if (active?.id !== serving) {
        // Ended through the API before its publisher arrived.
        logger.info({ streamId: serving }, 'live stream was stopped; closing the RTMP port');
        await this.ingest.disarm();
      } else if (active.stopRequestedAt !== null) {
        logger.info({ streamId: serving }, 'stopping live stream as requested');
        await this.ingest.disarm();
      } else if (active.status === 'waiting' && this.ingest.status().state === 'live') {
        // Recording the publisher's arrival failed earlier; record it now.
        await db.liveStreams.markLive(serving);
      }
      return;
    }

    if (active === null) return;
    if (active.status === 'live') {
      // Nothing here serves it: the live process that did stopped or died mid-stream.
      await this.interrupt(active);
    } else if (active.stopRequestedAt !== null) {
      await this.endStream(active.id, 'stopped');
    } else {
      this.ingest.arm(active.id);
      logger.info({ streamId: active.id }, 'live stream waiting for its publisher');
    }
  }

  private async onStarted(streamId: string): Promise<void> {
    if ((await this.options.db.liveStreams.markLive(streamId)) === null) {
      // Stopped through the API a moment before; the next check closes it.
      this.options.logger.warn({ streamId }, 'publisher connected to a stopped live stream');
    }
  }

  private async onEnded(streamId: string, session: EndedSession): Promise<void> {
    await this.endStream(streamId, this.shuttingDown ? 'interrupted' : session.reason);
  }

  private async endStream(streamId: string, reason: LiveEndReason): Promise<void> {
    const cleanupAfter = new Date(
      Date.now() + this.options.cleanupDelaySeconds * 1000,
    ).toISOString();
    const ended = await this.options.db.liveStreams.end(streamId, { reason, cleanupAfter });
    if (ended !== null) {
      this.options.logger.info({ streamId, reason, cleanupAfter }, 'live stream ended');
    }
  }

  /** End a stream whose live process is gone, marking its playlist as ended for players. */
  private async interrupt(stream: LiveStream): Promise<void> {
    const { storage } = this.options;
    const key = liveKey(stream.id, LIVE_PLAYLIST);
    const playlist = await readStoredText(storage, key);
    if (playlist !== null && !parseLivePlaylist(playlist).ended) {
      await storage.put(key, withEndList(playlist), {
        contentType: contentTypeForKey(LIVE_PLAYLIST),
      });
    }
    await this.endStream(stream.id, 'interrupted');
  }

  /** Delete the files of ended streams once their viewers have had time to finish. */
  private async cleanUp(): Promise<void> {
    const { db, storage, logger } = this.options;
    for (const stream of await db.liveStreams.listCleanupDue(new Date().toISOString())) {
      // Still publishing its last segments.
      if (stream.id === this.ingest.currentStreamId) continue;
      const files = await storage.deletePrefix(`${LIVE_PREFIX}/${stream.id}/`);
      await db.liveStreams.markCleaned(stream.id);
      logger.info({ streamId: stream.id, files }, 'live stream files deleted');
    }
  }

  /** Report this process's state when it changes, and every `reportMs` regardless. */
  private async report(): Promise<void> {
    const { state, error } = this.ingest.status();
    const key = `${state}\n${error ?? ''}`;
    const now = Date.now();
    if (this.lastReport?.state === key && now - this.lastReport.at < this.reportMs) return;
    await this.options.db.liveIngest.report({ state, error });
    this.lastReport = { state: key, at: now };
  }

  /**
   * Delete live files that no stream accounts for: streams whose cleanup was cut short, and
   * sessions from before streams were recorded (Milestone 14).
   */
  private async sweepOrphans(): Promise<void> {
    const { db, storage, logger } = this.options;
    const ids = new Set(
      (await storage.list(`${LIVE_PREFIX}/`)).map((object) => object.key.split('/')[1] ?? ''),
    );
    for (const id of ids) {
      if (id === '') continue;
      const stream = await db.liveStreams.get(id);
      if (stream !== null && stream.cleanedAt === null) continue;
      const files = await storage.deletePrefix(`${LIVE_PREFIX}/${id}/`);
      logger.info({ streamId: id, files }, 'deleted leftover live files');
    }
  }
}
