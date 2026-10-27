import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { MinimalLogger } from '../lib/logger.js';
import {
  isLiveFileName,
  LIVE_PLAYLIST,
  LIVE_SEGMENT_SECONDS,
  LIVE_START_SEGMENTS,
  LIVE_WINDOW_SEGMENTS,
  liveKey,
  parseLivePlaylist,
  withEndList,
} from '../lib/packaging/index.js';
import { contentTypeForKey, type ObjectStorage } from '../lib/storage/index.js';

export interface LiveMirrorOptions {
  streamId: string;
  /** The stream's work dir, where FFmpeg writes. */
  dir: string;
  storage: ObjectStorage;
  logger: MinimalLogger;
  /** How often to look for a new playlist. Defaults to 250 ms (an eighth of a segment). */
  pollMs?: number;
  /**
   * How long a segment stays in storage after leaving the playlist. Defaults to one segment
   * plus the whole window, the HLS spec's minimum: a player holding the previous playlist can
   * still fetch everything it lists.
   */
  retainRemovedMs?: number;
  /** Segments the first published playlist must list. Defaults to `LIVE_START_SEGMENTS`. */
  startSegments?: number;
}

/** A failed sync is retried on the next poll; this keeps a persistent failure's log readable. */
const ERROR_LOG_INTERVAL_MS = 30_000;
const FINAL_SYNC_ATTEMPTS = 3;

/**
 * Copies one live stream from its work dir to storage as FFmpeg produces it, so the API can
 * serve it from either storage backend. Each time the playlist changes, the segments it newly
 * lists go up first and the playlist after them, so a player never sees a segment before it is
 * fetchable. The first playlist waits until it lists `startSegments` segments, so players can
 * start a safe distance from the live edge. Segments that slide out of the window are deleted
 * once no player can still want them.
 */
export class LiveMirror {
  private readonly pollMs: number;
  private readonly retainRemovedMs: number;
  private readonly startSegments: number;
  /** The playlist text last written to storage. */
  private published: string | null = null;
  /** Files (init + segments) in storage. */
  private readonly stored = new Set<string>();
  /** Segments listed by the last published playlist. */
  private listed = new Set<string>();
  /** Segments that left the playlist, with when they left. */
  private readonly removed = new Map<string, number>();
  private stopping = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private lastErrorLogAt = 0;

  constructor(private readonly options: LiveMirrorOptions) {
    this.pollMs = options.pollMs ?? 250;
    this.retainRemovedMs =
      options.retainRemovedMs ?? (LIVE_WINDOW_SEGMENTS + 1) * LIVE_SEGMENT_SECONDS * 1000;
    this.startSegments = options.startSegments ?? LIVE_START_SEGMENTS;
  }

  /** Begin polling the work dir. */
  start(): void {
    this.loop ??= this.run();
  }

  /**
   * Stop polling and publish the stream's final state: the last segments, and a playlist that
   * is marked as ended even if FFmpeg could not write the end itself. Segments outside that
   * last window are deleted at once, since the stream is over.
   */
  async finish(): Promise<void> {
    this.stopping = true;
    this.wake?.();
    await this.loop;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.sync(true);
        return;
      } catch (err) {
        if (attempt >= FINAL_SYNC_ATTEMPTS) throw err;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.sync(false);
      } catch (err) {
        const now = Date.now();
        if (now - this.lastErrorLogAt >= ERROR_LOG_INTERVAL_MS) {
          this.lastErrorLogAt = now;
          this.options.logger.error(
            { err, streamId: this.options.streamId },
            'could not publish live segments to storage (will keep retrying)',
          );
        }
      }
      if (this.stopping) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.pollMs);
        this.wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wake = null;
    }
  }

  /** One pass: publish whatever changed since the last one. Safe to repeat after a failure. */
  async sync(final: boolean): Promise<void> {
    const { streamId, storage, logger } = this.options;
    const text = await this.readLocal(LIVE_PLAYLIST);
    if (text === null) return; // FFmpeg has not finished its first segment yet.
    const playlist = final ? withEndList(text) : text;

    const parsed = parseLivePlaylist(playlist);
    const tooShort =
      this.published === null && !parsed.ended && parsed.segments.length < this.startSegments;
    if (playlist !== this.published && !tooShort) {
      const files = parsed.initSegment ? [parsed.initSegment, ...parsed.segments] : parsed.segments;
      for (const file of files) {
        if (this.stored.has(file)) continue;
        // Names come from FFmpeg's own playlist, but nothing outside the stream's dir is ever read.
        if (!isLiveFileName(file)) throw new Error(`unexpected file in live playlist: ${file}`);
        try {
          await storage.putFile(liveKey(streamId, file), path.join(this.options.dir, file), {
            contentType: contentTypeForKey(file),
          });
        } catch (err) {
          // Gone already: this mirror fell so far behind that FFmpeg deleted it. Skip it rather
          // than hold up every later segment.
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
          logger.warn({ streamId, file }, 'live segment was gone before it could be published');
        }
        this.stored.add(file);
      }
      await storage.put(liveKey(streamId, LIVE_PLAYLIST), playlist, {
        contentType: contentTypeForKey(LIVE_PLAYLIST),
      });
      if (this.published === null) {
        logger.info(
          { streamId, playlist: `/api/live/${streamId}/${LIVE_PLAYLIST}` },
          'live playlist published',
        );
      }
      this.published = playlist;

      const now = Date.now();
      const nowListed = new Set(parsed.segments);
      for (const segment of this.listed) {
        if (!nowListed.has(segment)) this.removed.set(segment, now);
      }
      this.listed = nowListed;
    }

    await this.deleteExpired(final);
  }

  private async deleteExpired(all: boolean): Promise<void> {
    const cutoff = Date.now() - this.retainRemovedMs;
    for (const [segment, removedAt] of this.removed) {
      if (!all && removedAt > cutoff) continue;
      await this.options.storage.delete(liveKey(this.options.streamId, segment));
      this.removed.delete(segment);
      this.stored.delete(segment);
    }
  }

  private async readLocal(file: string): Promise<string | null> {
    try {
      return await readFile(path.join(this.options.dir, file), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }
}
