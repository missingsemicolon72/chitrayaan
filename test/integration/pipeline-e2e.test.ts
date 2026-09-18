import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Upload as TusClientUpload } from 'tus-js-client';

import type { Rendition, Video } from '../../src/lib/db/index.js';
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
}

/**
 * The full pipe: tus upload -> queue -> worker (real FFmpeg, full ladder) -> stored CMAF
 * package -> HLS master, DASH manifest, playlists and segments served back through the API.
 */
describe.skipIf(!READY)('upload to packaged ABR ladder, end to end', () => {
  let t: TestApp;
  let worker: TranscodeWorkerHandle;
  let headers: Record<string, string>;

  beforeAll(async () => {
    t = await createTestApp({ listen: true });
    headers = { 'X-API-Key': t.apiKey };
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
          // Deliberately not created up front: WORK_DIR may point at a fresh directory.
          workDir: path.join(t.storageRoot, 'work', 'nested'),
        }),
      }),
    });
  });

  afterAll(async () => {
    await worker.close();
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
