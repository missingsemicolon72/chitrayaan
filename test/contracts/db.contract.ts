import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ActiveLiveStreamError,
  RecordNotFoundError,
  type Database,
  type LiveEndReason,
  type VideoPatch,
} from '../../src/lib/db/index.js';

export interface DatabaseFixture {
  db: Database;
  teardown: () => Promise<void>;
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Behavioural contract every `Database` driver must satisfy. Milestone 11 runs this same suite
 * against Postgres. `setup` must return a fresh, empty, migrated database for each test.
 */
export function describeDatabaseContract(
  name: string,
  setup: () => Promise<DatabaseFixture>,
): void {
  describe(`Database contract: ${name}`, () => {
    let db: Database;
    let teardown: () => Promise<void>;

    beforeEach(async () => {
      ({ db, teardown } = await setup());
    });

    afterEach(async () => {
      await teardown();
    });

    it('migrate is idempotent and ping succeeds', async () => {
      await expect(db.migrate()).resolves.toBeUndefined();
      await expect(db.ping()).resolves.toBeUndefined();
    });

    describe('videos', () => {
      it('creates with defaults and reads back', async () => {
        const created = await db.videos.create({});
        expect(created.id).toMatch(UUID);
        expect(created.status).toBe('uploading');
        expect(created.title).toBeNull();
        expect(created.sourceKey).toBeNull();
        expect(created.sizeBytes).toBeNull();
        expect(created.durationSeconds).toBeNull();
        expect(created.hlsManifestKey).toBeNull();
        expect(created.dashManifestKey).toBeNull();
        expect(created.createdAt).toMatch(ISO_UTC);
        expect(created.updatedAt).toBe(created.createdAt);

        expect(await db.videos.get(created.id)).toEqual(created);
      });

      it('creates with explicit fields, including a caller-supplied id', async () => {
        const created = await db.videos.create({
          id: 'vid-1',
          title: 'Clip',
          originalFilename: 'clip.mp4',
          sourceKey: 'uploads/vid-1/clip.mp4',
          sizeBytes: 3_000_000_000, // > 2^31: must survive as a number
          status: 'uploaded',
        });
        expect(created).toMatchObject({
          id: 'vid-1',
          title: 'Clip',
          originalFilename: 'clip.mp4',
          sourceKey: 'uploads/vid-1/clip.mp4',
          sizeBytes: 3_000_000_000,
          status: 'uploaded',
        });
        expect(await db.videos.get('vid-1')).toEqual(created);
      });

      it('returns null for an unknown id', async () => {
        expect(await db.videos.get('missing')).toBeNull();
        expect(await db.videos.update('missing', { title: 'x' })).toBeNull();
        expect(await db.videos.delete('missing')).toBe(false);
      });

      it('updates fields, bumps updatedAt, and leaves other fields alone', async () => {
        const created = await db.videos.create({ title: 'before' });
        const updated = await db.videos.update(created.id, {
          status: 'ready',
          durationSeconds: 12.5,
          width: 1280,
          height: 720,
          error: null,
          hlsManifestKey: `videos/${created.id}/master.m3u8`,
          dashManifestKey: `videos/${created.id}/master.mpd`,
        });
        expect(updated).toMatchObject({
          id: created.id,
          title: 'before',
          status: 'ready',
          durationSeconds: 12.5,
          width: 1280,
          height: 720,
          hlsManifestKey: `videos/${created.id}/master.m3u8`,
          dashManifestKey: `videos/${created.id}/master.mpd`,
          createdAt: created.createdAt,
        });
        expect(updated?.updatedAt.localeCompare(created.updatedAt)).toBeGreaterThanOrEqual(0);

        // Explicit null clears; a runtime `undefined` (e.g. from a partially-filled request
        // body) is ignored. The double cast is needed because the type forbids `undefined`.
        const sloppyPatch = { title: null, width: undefined } as unknown as VideoPatch;
        const cleared = await db.videos.update(created.id, sloppyPatch);
        expect(cleared?.title).toBeNull();
        expect(cleared?.width).toBe(1280);

        // Empty patch is a plain read.
        expect(await db.videos.update(created.id, {})).toEqual(cleared);
      });

      it('lists newest first with pagination and status filter', async () => {
        const ids: string[] = [];
        for (let i = 0; i < 5; i += 1) {
          ids.push((await db.videos.create({ status: i % 2 === 0 ? 'ready' : 'failed' })).id);
        }

        const all = await db.videos.list();
        expect(all).toMatchObject({ total: 5, limit: 50, offset: 0 });
        expect(all.items).toHaveLength(5);
        for (let i = 1; i < all.items.length; i += 1) {
          const prev = all.items[i - 1]!;
          const cur = all.items[i]!;
          expect(prev.createdAt.localeCompare(cur.createdAt)).toBeGreaterThanOrEqual(0);
        }
        expect(all.items.map((v) => v.id).sort()).toEqual([...ids].sort());

        const page = await db.videos.list({ limit: 2, offset: 2 });
        expect(page).toMatchObject({ total: 5, limit: 2, offset: 2 });
        expect(page.items.map((v) => v.id)).toEqual(all.items.slice(2, 4).map((v) => v.id));

        const ready = await db.videos.list({ status: 'ready' });
        expect(ready.total).toBe(3);
        expect(ready.items.every((v) => v.status === 'ready')).toBe(true);

        expect((await db.videos.list({ limit: 0 })).limit).toBe(1);
        expect((await db.videos.list({ limit: 10_000 })).limit).toBe(200);
        expect((await db.videos.list({ offset: -5 })).offset).toBe(0);
      });

      it('delete removes the video and cascades to its jobs', async () => {
        const video = await db.videos.create({});
        const job = await db.jobs.create({ videoId: video.id });

        expect(await db.videos.delete(video.id)).toBe(true);
        expect(await db.videos.get(video.id)).toBeNull();
        expect(await db.jobs.get(job.id)).toBeNull();
        expect(await db.videos.delete(video.id)).toBe(false);
      });
    });

    describe('renditions', () => {
      const rendition = (videoId: string, name: string, height: number) => ({
        videoId,
        name,
        codec: 'h264' as const,
        width: Math.round((height * 16) / 9),
        height,
        videoBitrateKbps: height * 4,
        audioBitrateKbps: 128,
        playlistKey: `videos/${videoId}/${name}/index.m3u8`,
        segmentCount: 3,
        sizeBytes: 5_000_000_000,
        durationSeconds: 12.5,
      });

      it('replaces the set atomically and lists by ascending height', async () => {
        const video = await db.videos.create({});
        expect(await db.renditions.listForVideo(video.id)).toEqual([]);

        const first = await db.renditions.replaceForVideo(video.id, [
          rendition(video.id, 'h264_720p', 720),
          rendition(video.id, 'h264_360p', 360),
        ]);
        expect(first.map((r) => r.name)).toEqual(['h264_360p', 'h264_720p']);
        expect(first[0]).toMatchObject({
          videoId: video.id,
          codec: 'h264',
          width: 640,
          height: 360,
          sizeBytes: 5_000_000_000,
          durationSeconds: 12.5,
        });
        expect(first[0]?.id).toMatch(UUID);
        expect(first[0]?.createdAt).toMatch(ISO_UTC);

        const second = await db.renditions.replaceForVideo(video.id, [
          { ...rendition(video.id, 'h264_720p', 720), audioBitrateKbps: null, sizeBytes: null },
        ]);
        expect(second).toHaveLength(1);
        expect(second[0]).toMatchObject({
          name: 'h264_720p',
          audioBitrateKbps: null,
          sizeBytes: null,
        });
        expect(await db.renditions.listForVideo(video.id)).toEqual(second);

        expect(await db.renditions.replaceForVideo(video.id, [])).toEqual([]);
      });

      it('is scoped per video and removed with the video', async () => {
        const a = await db.videos.create({});
        const b = await db.videos.create({});
        await db.renditions.replaceForVideo(a.id, [rendition(a.id, 'h264_720p', 720)]);
        await db.renditions.replaceForVideo(b.id, [rendition(b.id, 'h264_480p', 480)]);
        expect((await db.renditions.listForVideo(a.id)).map((r) => r.name)).toEqual(['h264_720p']);
        expect((await db.renditions.listForVideo(b.id)).map((r) => r.name)).toEqual(['h264_480p']);

        await db.videos.delete(a.id);
        expect(await db.renditions.listForVideo(a.id)).toEqual([]);
        expect(await db.renditions.listForVideo(b.id)).toHaveLength(1);
      });
    });

    describe('subtitles', () => {
      const track = (videoId: string, language: string, over = {}) => ({
        videoId,
        language,
        label: language.toUpperCase(),
        storageKey: `videos/${videoId}/subtitles/${language}.vtt`,
        cueCount: 3,
        sizeBytes: 512,
        ...over,
      });

      it('inserts, reads back, and replaces by (video, language)', async () => {
        const video = await db.videos.create({});
        expect(await db.subtitles.listForVideo(video.id)).toEqual([]);
        expect(await db.subtitles.get(video.id, 'en')).toBeNull();

        const created = await db.subtitles.upsert(track(video.id, 'en'));
        expect(created).toMatchObject({
          videoId: video.id,
          language: 'en',
          label: 'EN',
          isDefault: false,
          cueCount: 3,
          sizeBytes: 512,
        });
        expect(created.id).toMatch(UUID);
        expect(created.createdAt).toMatch(ISO_UTC);

        const replaced = await db.subtitles.upsert(
          track(video.id, 'en', { label: 'English', cueCount: 9 }),
        );
        expect(replaced.id).toBe(created.id);
        expect(replaced).toMatchObject({ label: 'English', cueCount: 9 });
        expect(await db.subtitles.listForVideo(video.id)).toHaveLength(1);
      });

      it('keeps at most one default track per video and lists by language', async () => {
        const video = await db.videos.create({});
        const other = await db.videos.create({});
        await db.subtitles.upsert(track(video.id, 'fr', { isDefault: true }));
        await db.subtitles.upsert(track(video.id, 'en', { isDefault: true }));
        await db.subtitles.upsert(track(other.id, 'de', { isDefault: true }));

        const tracks = await db.subtitles.listForVideo(video.id);
        expect(tracks.map((t) => t.language)).toEqual(['en', 'fr']);
        expect(tracks.filter((t) => t.isDefault).map((t) => t.language)).toEqual(['en']);
        // Another video's default is unaffected.
        expect((await db.subtitles.get(other.id, 'de'))?.isDefault).toBe(true);
      });

      it('deletes a track and cascades with its video', async () => {
        const video = await db.videos.create({});
        await db.subtitles.upsert(track(video.id, 'en'));
        expect(await db.subtitles.delete(video.id, 'en')).toBe(true);
        expect(await db.subtitles.delete(video.id, 'en')).toBe(false);

        await db.subtitles.upsert(track(video.id, 'es'));
        await db.videos.delete(video.id);
        expect(await db.subtitles.listForVideo(video.id)).toEqual([]);
      });

      it('refuses a track for an unknown video', async () => {
        await expect(db.subtitles.upsert(track('ghost', 'en'))).rejects.toBeInstanceOf(
          RecordNotFoundError,
        );
      });
    });

    describe('jobs', () => {
      it('creates with defaults, tied to an existing video', async () => {
        const video = await db.videos.create({});
        const job = await db.jobs.create({ videoId: video.id });
        expect(job.id).toMatch(UUID);
        expect(job).toMatchObject({
          videoId: video.id,
          type: 'transcode',
          status: 'queued',
          progress: 0,
          attempts: 0,
          queueJobId: null,
          error: null,
          startedAt: null,
          finishedAt: null,
        });
        expect(job.createdAt).toMatch(ISO_UTC);
        expect(await db.jobs.get(job.id)).toEqual(job);
      });

      it('refuses to create a job for an unknown video', async () => {
        await expect(db.jobs.create({ videoId: 'ghost' })).rejects.toBeInstanceOf(
          RecordNotFoundError,
        );
      });

      it('updates lifecycle fields', async () => {
        const video = await db.videos.create({});
        const job = await db.jobs.create({ videoId: video.id, queueJobId: 'bull-1' });

        const active = await db.jobs.update(job.id, {
          status: 'active',
          attempts: 1,
          startedAt: new Date().toISOString(),
        });
        expect(active).toMatchObject({ status: 'active', attempts: 1, queueJobId: 'bull-1' });
        expect(active?.startedAt).toMatch(ISO_UTC);

        const halfway = await db.jobs.update(job.id, { progress: 50 });
        expect(halfway?.progress).toBe(50);

        const failed = await db.jobs.update(job.id, {
          status: 'failed',
          error: 'ffmpeg exited with code 1',
          finishedAt: new Date().toISOString(),
        });
        expect(failed).toMatchObject({ status: 'failed', error: 'ffmpeg exited with code 1' });

        expect(await db.jobs.update('missing', { progress: 1 })).toBeNull();
        expect(await db.jobs.delete(job.id)).toBe(true);
        expect(await db.jobs.delete(job.id)).toBe(false);
      });

      it('lists newest first, filtered by video and status', async () => {
        const v1 = await db.videos.create({});
        const v2 = await db.videos.create({});
        const j1 = await db.jobs.create({ videoId: v1.id });
        const j2 = await db.jobs.create({ videoId: v1.id, status: 'completed' });
        const j3 = await db.jobs.create({ videoId: v2.id });

        const all = await db.jobs.list();
        expect(all.total).toBe(3);
        expect(all.items.map((j) => j.id).sort()).toEqual([j1.id, j2.id, j3.id].sort());

        const forV1 = await db.jobs.list({ videoId: v1.id });
        expect(forV1.total).toBe(2);
        expect(forV1.items.map((j) => j.id).sort()).toEqual([j1.id, j2.id].sort());

        const queued = await db.jobs.list({ status: 'queued' });
        expect(queued.items.map((j) => j.id).sort()).toEqual([j1.id, j3.id].sort());

        const both = await db.jobs.list({ videoId: v1.id, status: 'completed' });
        expect(both.items.map((j) => j.id)).toEqual([j2.id]);

        const page = await db.jobs.list({ limit: 1, offset: 1 });
        expect(page).toMatchObject({ total: 3, limit: 1, offset: 1 });
        expect(page.items).toHaveLength(1);
      });
    });

    describe('live streams', () => {
      const end = (reason: LiveEndReason, cleanupAfter = '2000-01-01T00:00:00.000Z') => ({
        reason,
        cleanupAfter,
      });

      it('creates a waiting stream, and only one may be active at a time', async () => {
        const stream = await db.liveStreams.create();
        expect(stream.id).toMatch(UUID);
        expect(stream).toMatchObject({
          status: 'waiting',
          endReason: null,
          stopRequestedAt: null,
          startedAt: null,
          endedAt: null,
          cleanupAfter: null,
          cleanedAt: null,
        });
        expect(stream.createdAt).toMatch(ISO_UTC);
        expect(await db.liveStreams.get(stream.id)).toEqual(stream);
        expect(await db.liveStreams.getActive()).toEqual(stream);

        const refused = await db.liveStreams.create().catch((err: unknown) => err);
        expect(refused).toBeInstanceOf(ActiveLiveStreamError);
        expect((refused as ActiveLiveStreamError).active.id).toBe(stream.id);

        // Once it has ended, the next one may start.
        await db.liveStreams.end(stream.id, end('stopped'));
        expect(await db.liveStreams.getActive()).toBeNull();
        const next = await db.liveStreams.create();
        expect((await db.liveStreams.getActive())?.id).toBe(next.id);
      });

      it('goes live once, and ends once, from either active state', async () => {
        const stream = await db.liveStreams.create();
        const live = await db.liveStreams.markLive(stream.id);
        expect(live).toMatchObject({ id: stream.id, status: 'live' });
        expect(live?.startedAt).toMatch(ISO_UTC);
        expect(await db.liveStreams.markLive(stream.id)).toBeNull();

        const ended = await db.liveStreams.end(
          stream.id,
          end('publisher-disconnected', '2030-01-01T00:00:00.000Z'),
        );
        expect(ended).toMatchObject({
          status: 'ended',
          endReason: 'publisher-disconnected',
          cleanupAfter: '2030-01-01T00:00:00.000Z',
          startedAt: live?.startedAt,
        });
        expect(ended?.endedAt).toMatch(ISO_UTC);
        expect(await db.liveStreams.end(stream.id, end('stopped'))).toBeNull();
        expect(await db.liveStreams.markLive(stream.id)).toBeNull();
        expect((await db.liveStreams.get(stream.id))?.endReason).toBe('publisher-disconnected');

        // A waiting stream can end without ever going live.
        const unused = await db.liveStreams.create();
        expect(await db.liveStreams.end(unused.id, end('stopped'))).toMatchObject({
          status: 'ended',
          startedAt: null,
        });
        expect(await db.liveStreams.end('ghost', end('stopped'))).toBeNull();
      });

      it('records a stop request once, and only on an active stream', async () => {
        const stream = await db.liveStreams.create();
        const first = await db.liveStreams.requestStop(stream.id);
        expect(first?.stopRequestedAt).toMatch(ISO_UTC);
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect((await db.liveStreams.requestStop(stream.id))?.stopRequestedAt).toBe(
          first?.stopRequestedAt,
        );
        await db.liveStreams.end(stream.id, end('stopped'));
        expect(await db.liveStreams.requestStop(stream.id)).toBeNull();
        expect(await db.liveStreams.requestStop('ghost')).toBeNull();
      });

      it('lists ended streams due for cleanup until they are marked cleaned', async () => {
        const due = await db.liveStreams.create();
        await db.liveStreams.end(due.id, end('stopped', '2026-01-01T00:00:00.000Z'));
        const later = await db.liveStreams.create();
        await db.liveStreams.end(later.id, end('stopped', '2026-01-01T00:10:00.000Z'));
        const active = await db.liveStreams.create();

        const now = '2026-01-01T00:05:00.000Z';
        expect((await db.liveStreams.listCleanupDue(now)).map((s) => s.id)).toEqual([due.id]);
        const cleaned = await db.liveStreams.markCleaned(due.id);
        expect(cleaned?.cleanedAt).toMatch(ISO_UTC);
        expect(await db.liveStreams.markCleaned(due.id)).toBeNull();
        expect(await db.liveStreams.markCleaned(active.id)).toBeNull();
        expect(await db.liveStreams.listCleanupDue(now)).toEqual([]);
        expect(
          (await db.liveStreams.listCleanupDue('2026-01-01T00:10:00.000Z')).map((s) => s.id),
        ).toEqual([later.id]);
      });

      it('lists newest first, filtered by status, and deletes', async () => {
        const first = await db.liveStreams.create();
        await db.liveStreams.end(first.id, end('stopped'));
        await new Promise((resolve) => setTimeout(resolve, 5));
        const second = await db.liveStreams.create();

        const all = await db.liveStreams.list();
        expect(all).toMatchObject({ total: 2, limit: 50, offset: 0 });
        expect(all.items.map((s) => s.id)).toEqual([second.id, first.id]);
        expect((await db.liveStreams.list({ status: 'ended' })).items.map((s) => s.id)).toEqual([
          first.id,
        ]);
        expect((await db.liveStreams.list({ limit: 1, offset: 1 })).items).toHaveLength(1);

        expect(await db.liveStreams.delete(first.id)).toBe(true);
        expect(await db.liveStreams.delete(first.id)).toBe(false);
        expect(await db.liveStreams.get(first.id)).toBeNull();
      });

      it("keeps the live process's latest report", async () => {
        await db.liveIngest.report({ state: 'listening', error: null });
        const first = await db.liveIngest.get();
        expect(first).toMatchObject({ state: 'listening', error: null });
        expect(first?.reportedAt).toMatch(ISO_UTC);

        await db.liveIngest.report({ state: 'restarting', error: 'port 1935 is in use' });
        expect(await db.liveIngest.get()).toMatchObject({
          state: 'restarting',
          error: 'port 1935 is in use',
        });
      });
    });
  });
}
