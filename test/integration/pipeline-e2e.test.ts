import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Upload as TusClientUpload } from 'tus-js-client';

import type { Codec, Rendition, Video } from '../../src/lib/db/index.js';
import { parseHlsMaster, parseMpd } from '../../src/lib/packaging/index.js';
import { createTranscodeWorker, type TranscodeWorkerHandle } from '../../src/lib/queue/index.js';
import { createTranscodeProcessor } from '../../src/worker/processors/transcode.js';
import { createJobRunner } from '../../src/worker/runner.js';
import { createTestApp, type TestApp } from '../helpers/app.js';
import { FFMPEG_PATH, FFPROBE_PATH, ffmpegAvailable, fixturePath } from '../helpers/ffmpeg.js';
import { redisAvailable, TEST_REDIS_URL } from '../helpers/redis.js';
import { waitFor } from '../helpers/wait.js';

const READY = (await redisAvailable()) && (await ffmpegAvailable());

interface VideoView extends Video {
  jobs: { id: string; status: string; progress: number }[];
  manifests: { hls: string | null; dash: string | null };
  renditions: (Rendition & { playlistUrl: string | null })[];
  subtitles: { language: string; label: string; isDefault: boolean; cueCount: number }[];
  thumbnails: { trackUrl: string; spriteCount: number } | null;
}

/**
 * The full pipe: tus upload -> queue -> worker (real FFmpeg, full ladder) -> stored CMAF
 * package -> HLS master, DASH manifest, playlists and segments served back through the API.
 */
describe.skipIf(!READY)('upload to packaged ABR ladder, end to end', () => {
  let t: TestApp;
  let worker: TranscodeWorkerHandle | undefined;
  let headers: Record<string, string>;

  const startWorker = (codecs: readonly Codec[], features: { thumbnails?: boolean } = {}) => {
    worker = createTranscodeWorker({
      redisUrl: TEST_REDIS_URL,
      prefix: t.queuePrefix,
      processor: createJobRunner({
        db: t.app.db,
        storage: t.app.storage,
        log: pino({ level: 'silent' }),
        processor: createTranscodeProcessor({
          ffmpegPath: FFMPEG_PATH,
          ffprobePath: FFPROBE_PATH,
          preset: 'ultrafast',
          av1Preset: 12,
          codecs,
          thumbnails: features.thumbnails === true,
          // Deliberately not created up front: WORK_DIR may point at a fresh directory.
          workDir: path.join(t.storageRoot, 'work', 'nested'),
        }),
      }),
    });
  };

  beforeAll(async () => {
    t = await createTestApp({
      listen: true,
      env: { FEATURE_SUBTITLES: 'true', FEATURE_THUMBNAILS: 'true' },
    });
    headers = { 'X-API-Key': t.apiKey };
  });

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
  });

  afterAll(async () => {
    await t.close();
  });

  async function uploadFixture(name: string): Promise<string> {
    const data = await readFile(fixturePath(name));
    return new Promise<string>((resolve, reject) => {
      const upload = new TusClientUpload(data, {
        endpoint: `${t.baseUrl}/api/uploads`,
        chunkSize: 256 * 1024,
        retryDelays: [0, 100],
        headers,
        metadata: { filename: name, filetype: 'video/mp4' },
        storeFingerprintForResuming: false,
        onError: reject,
        onSuccess: () => resolve(upload.url!.split('/').pop()!),
      });
      upload.start();
    });
  }

  const settledJob = (id: string) =>
    waitFor(
      async () => (await t.app.db.jobs.list({ videoId: id })).items[0],
      (j) => j?.status === 'completed' || j?.status === 'failed',
      { timeoutMs: 90_000, intervalMs: 200 },
    );

  const getJson = async <T>(url: string): Promise<{ status: number; body: T }> => {
    const res = await fetch(`${t.baseUrl}${url}`, { headers });
    return { status: res.status, body: (await res.json()) as T };
  };

  it('packages a 480p source into two rungs with HLS + DASH manifests and serves it all', async () => {
    startWorker(['h264']);
    const id = await uploadFixture('480p-5s.mp4');
    const job = await settledJob(id);
    expect(job?.error).toBeNull();
    expect(job).toMatchObject({ status: 'completed', progress: 100 });

    const { status, body: video } = await getJson<VideoView>(`/api/videos/${id}`);
    expect(status).toBe(200);
    expect(video).toMatchObject({
      status: 'ready',
      width: 854,
      height: 480,
      originalFilename: '480p-5s.mp4',
      hlsManifestKey: `videos/${id}/master.m3u8`,
      dashManifestKey: `videos/${id}/master.mpd`,
      manifests: { hls: `/api/videos/${id}/master.m3u8`, dash: `/api/videos/${id}/master.mpd` },
    });
    expect(video.durationSeconds).toBeCloseTo(5, 0);

    expect(video.renditions.map((r) => r.name)).toEqual(['h264_360p', 'h264_480p']);
    expect(video.renditions[0]).toMatchObject({
      codec: 'h264',
      width: 640,
      height: 360,
      videoBitrateKbps: 800,
      audioBitrateKbps: 128,
      playlistKey: `videos/${id}/media_0.m3u8`,
      playlistUrl: `/api/videos/${id}/media_0.m3u8`,
      segmentCount: 2, // 5s at 4s segments
    });
    expect(video.renditions[1]).toMatchObject({
      width: 854,
      height: 480,
      playlistUrl: `/api/videos/${id}/media_1.m3u8`,
    });
    expect(video.renditions.every((r) => (r.sizeBytes ?? 0) > 0)).toBe(true);

    // HLS master: two variants + the shared audio group.
    const masterRes = await fetch(`${t.baseUrl}${video.manifests.hls!}`, { headers });
    expect(masterRes.status).toBe(200);
    expect(masterRes.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
    const master = parseHlsMaster(await masterRes.text());
    expect(master.variants.map((v) => `${v.width}x${v.height}`)).toEqual(['640x360', '854x480']);
    expect(master.media).toHaveLength(1);

    // DASH manifest over the very same segments.
    const mpdRes = await fetch(`${t.baseUrl}${video.manifests.dash!}`, { headers });
    expect(mpdRes.status).toBe(200);
    expect(mpdRes.headers.get('content-type')).toBe('application/dash+xml');
    const mpd = parseMpd(await mpdRes.text());
    expect(
      mpd.representations.filter((r) => r.contentType === 'video').map((r) => r.height),
    ).toEqual([360, 480]);
    expect(mpd.representations.filter((r) => r.contentType === 'audio')).toHaveLength(1);

    // Playlists, init and media segments all come back with the right types.
    const media = await fetch(`${t.baseUrl}${video.renditions[1]!.playlistUrl!}`, { headers });
    expect(media.status).toBe(200);
    expect(await media.text()).toContain('#EXT-X-MAP:URI="init-stream1.m4s"');
    for (const file of ['init-stream1.m4s', 'chunk-stream1-00001.m4s', 'init-stream2.m4s']) {
      const res = await fetch(`${t.baseUrl}/api/videos/${id}/${file}`, { headers });
      expect(res.status, file).toBe(200);
      expect(res.headers.get('content-type'), file).toBe('video/iso.segment');
      expect((await res.arrayBuffer()).byteLength, file).toBe(
        Number(res.headers.get('content-length')),
      );
    }
  }, 120_000);

  it('adds AV1 renditions when CODEC_LADDER opts in, streams numbered H.264 first', async () => {
    startWorker(['h264', 'av1']);
    const id = await uploadFixture('480p-5s.mp4');
    const job = await settledJob(id);
    expect(job?.error).toBeNull();
    expect(job?.status).toBe('completed');

    const { body: video } = await getJson<VideoView>(`/api/videos/${id}`);
    expect(video.status).toBe('ready');
    // Listed by height then name; stream numbers show H.264 rungs were mapped first.
    expect(video.renditions.map((r) => `${r.name}:${r.codec}:${r.playlistUrl}`)).toEqual([
      `av1_360p:av1:/api/videos/${id}/media_2.m3u8`,
      `h264_360p:h264:/api/videos/${id}/media_0.m3u8`,
      `av1_480p:av1:/api/videos/${id}/media_3.m3u8`,
      `h264_480p:h264:/api/videos/${id}/media_1.m3u8`,
    ]);
    expect(video.renditions.find((r) => r.name === 'av1_480p')).toMatchObject({
      width: 854,
      height: 480,
      videoBitrateKbps: 900,
      segmentCount: 2,
    });

    const mpd = parseMpd(
      await (await fetch(`${t.baseUrl}${video.manifests.dash!}`, { headers })).text(),
    );
    expect(mpd.adaptationSets).toBe(3);
    expect(
      mpd.representations.filter((r) => r.codecs?.startsWith('av01')).map((r) => r.height),
    ).toEqual([360, 480]);

    const master = parseHlsMaster(
      await (await fetch(`${t.baseUrl}${video.manifests.hls!}`, { headers })).text(),
    );
    expect(master.variants.filter((v) => v.codecs?.startsWith('av01'))).toHaveLength(2);
    expect(master.variants.filter((v) => v.codecs?.startsWith('avc1'))).toHaveLength(2);

    const av1Init = await fetch(`${t.baseUrl}/api/videos/${id}/init-stream3.m4s`, { headers });
    expect(av1Init.status).toBe(200);
  }, 180_000);

  it('generates scrubbing sprites, accepts a subtitle track, and keeps it across a re-transcode', async () => {
    startWorker(['h264'], { thumbnails: true });
    const id = await uploadFixture('480p-5s.mp4');
    expect((await settledJob(id))?.status).toBe('completed');

    // Thumbnails: the track and its sprite sheet are stored and served.
    const { body: withThumbs } = await getJson<VideoView>(`/api/videos/${id}`);
    expect(withThumbs.thumbnails).toMatchObject({
      trackUrl: `/api/videos/${id}/thumbs/thumbnails.vtt`,
      spriteCount: 1,
    });
    const trackRes = await fetch(`${t.baseUrl}${withThumbs.thumbnails!.trackUrl}`, { headers });
    expect(trackRes.status).toBe(200);
    expect(trackRes.headers.get('content-type')).toMatch(/text\/vtt/);
    const trackBody = await trackRes.text();
    expect(trackBody.startsWith('WEBVTT')).toBe(true);
    const sprite = /(sprite_\d+\.jpg)#xywh=/.exec(trackBody)?.[1];
    expect(sprite).toBe('sprite_000.jpg');
    const spriteRes = await fetch(`${t.baseUrl}/api/videos/${id}/thumbs/${sprite}`, { headers });
    expect(spriteRes.status).toBe(200);
    expect(spriteRes.headers.get('content-type')).toBe('image/jpeg');
    expect((await spriteRes.arrayBuffer()).byteLength).toBeGreaterThan(1000);

    // Subtitles: uploaded through the API, then present in both served manifests.
    const vtt = 'WEBVTT\n\n00:00:00.500 --> 00:00:02.000\nHello\n';
    const put = await fetch(
      `${t.baseUrl}/api/videos/${id}/subtitles/en?label=English&default=true`,
      {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'text/vtt' },
        body: vtt,
      },
    );
    expect(put.status).toBe(201);

    const master = parseHlsMaster(
      await (await fetch(`${t.baseUrl}/api/videos/${id}/master.m3u8`, { headers })).text(),
    );
    expect(master.media.filter((m) => m.type === 'SUBTITLES')).toHaveLength(1);
    const subPlaylist = await fetch(`${t.baseUrl}/api/videos/${id}/subtitles/en.m3u8`, { headers });
    expect(subPlaylist.status).toBe(200);
    expect(subPlaylist.body).not.toBeNull();
    const mpdBody = await (
      await fetch(`${t.baseUrl}/api/videos/${id}/master.mpd`, { headers })
    ).text();
    // The track is a text adaptation set carrying the .vtt directly (mimeType sits on the set).
    expect(parseMpd(mpdBody).representations.some((r) => r.contentType === 'text')).toBe(true);
    expect(mpdBody).toContain('mimeType="text/vtt" lang="en"');
    expect(mpdBody).toContain('<BaseURL>subtitles/en.vtt</BaseURL>');

    // Re-transcoding replaces the packaged output but must not take the subtitles with it.
    const rerun = await t.app.db.jobs.create({ videoId: id });
    await t.queue.enqueue(rerun);
    const done = await waitFor(
      () => t.app.db.jobs.get(rerun.id),
      (j) => j?.status === 'completed' || j?.status === 'failed',
      { timeoutMs: 90_000, intervalMs: 200 },
    );
    expect(done?.status).toBe('completed');
    expect(await t.app.storage.exists(`videos/${id}/subtitles/en.vtt`)).toBe(true);
    expect(await t.app.db.subtitles.get(id, 'en')).not.toBeNull();

    const after = await getJson<VideoView>(`/api/videos/${id}`);
    expect(after.body.subtitles.map((s) => s.language)).toEqual(['en']);
    expect(after.body.thumbnails?.spriteCount).toBe(1);
    expect(
      (await fetch(`${t.baseUrl}/api/videos/${id}/thumbs/sprite_000.jpg`, { headers })).status,
    ).toBe(200);
  }, 180_000);

  it('serving refuses traversal, unknown files, and missing keys', async () => {
    const videos = await t.app.db.videos.list({ status: 'ready' });
    const id = videos.items[0]?.id ?? 'none';
    expect((await fetch(`${t.baseUrl}/api/videos/${id}/../../secret`, { headers })).status).toBe(
      404,
    );
    expect((await fetch(`${t.baseUrl}/api/videos/${id}/nope.m4s`, { headers })).status).toBe(404);
    expect((await fetch(`${t.baseUrl}/api/videos/${id}/master.m3u8`)).status).toBe(401);
  });

  it('fails the job with a readable error for a non-video upload and marks the video failed', async () => {
    startWorker(['h264']);
    const id = await uploadFixture('not-a-video.mp4');
    const job = await settledJob(id);
    expect(job?.status).toBe('failed');
    expect(job?.error).toMatch(/unreadable source/);
    const { body: video } = await getJson<VideoView>(`/api/videos/${id}`);
    expect(video.status).toBe('failed');
    expect(video.error).toBe(job?.error);
    expect(video.renditions).toEqual([]);
    expect(video.manifests).toEqual({ hls: null, dash: null });
  }, 90_000);
});
