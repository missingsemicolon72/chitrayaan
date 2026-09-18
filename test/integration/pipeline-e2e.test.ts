import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Upload as TusClientUpload } from 'tus-js-client';

import type { Rendition, Video } from '../../src/lib/db/index.js';
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
  renditions: (Rendition & { playlistUrl: string })[];
}

/**
 * Milestone 5's vertical slice: tus upload -> queue -> worker (real FFmpeg) -> stored CMAF
 * rendition -> served back through the API.
 */
describe.skipIf(!READY)('upload to playable rendition, end to end', () => {
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

  const getJson = async <T>(url: string): Promise<{ status: number; body: T }> => {
    const res = await fetch(`${t.baseUrl}${url}`, { headers });
    return { status: res.status, body: (await res.json()) as T };
  };

  it('produces a 720p-rung rendition, records it, and serves playlist + segments', async () => {
    const id = await uploadFixture('480p-5s.mp4');

    const job = await waitFor(
      async () => (await t.app.db.jobs.list({ videoId: id })).items[0],
      (j) => j?.status === 'completed' || j?.status === 'failed',
      { timeoutMs: 90_000, intervalMs: 200 },
    );
    expect(job?.error).toBeNull();
    expect(job).toMatchObject({ status: 'completed', progress: 100 });

    const { status, body: video } = await getJson<VideoView>(`/api/videos/${id}`);
    expect(status).toBe(200);
    expect(video).toMatchObject({
      status: 'ready',
      width: 854,
      height: 480,
      originalFilename: '480p-5s.mp4',
    });
    expect(video.durationSeconds).toBeCloseTo(5, 0);
    expect(video.renditions).toHaveLength(1);
    const rendition = video.renditions[0]!;
    // The rung is 720p but the source is smaller, so the output keeps 854x480.
    expect(rendition).toMatchObject({
      name: 'h264_720p',
      codec: 'h264',
      width: 854,
      height: 480,
      videoBitrateKbps: 2800,
      audioBitrateKbps: 128,
      playlistKey: `videos/${id}/h264_720p/index.m3u8`,
      playlistUrl: `/api/videos/${id}/h264_720p/index.m3u8`,
    });
    expect(rendition.segmentCount).toBeGreaterThanOrEqual(2);
    expect(rendition.sizeBytes).toBeGreaterThan(0);

    const playlistRes = await fetch(`${t.baseUrl}${rendition.playlistUrl}`, { headers });
    expect(playlistRes.status).toBe(200);
    expect(playlistRes.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
    const playlist = await playlistRes.text();
    expect(playlist).toContain('#EXTM3U');
    expect(playlist).toContain('#EXT-X-MAP:URI="init.mp4"');
    expect(playlist).toContain('#EXT-X-ENDLIST');

    const init = await fetch(`${t.baseUrl}/api/videos/${id}/h264_720p/init.mp4`, { headers });
    expect(init.status).toBe(200);
    expect(init.headers.get('content-type')).toBe('video/mp4');
    const segment = await fetch(`${t.baseUrl}/api/videos/${id}/h264_720p/seg_000.m4s`, { headers });
    expect(segment.status).toBe(200);
    expect(segment.headers.get('content-type')).toBe('video/iso.segment');
    expect(Number(segment.headers.get('content-length'))).toBeGreaterThan(1000);
    expect((await segment.arrayBuffer()).byteLength).toBe(
      Number(segment.headers.get('content-length')),
    );
  }, 120_000);

  it('serving refuses traversal, unknown files, and missing keys', async () => {
    const videos = await t.app.db.videos.list({ status: 'ready' });
    const id = videos.items[0]?.id ?? 'none';
    expect(
      (await fetch(`${t.baseUrl}/api/videos/${id}/h264_720p/../../secret`, { headers })).status,
    ).toBe(404);
    expect(
      (await fetch(`${t.baseUrl}/api/videos/${id}/h264_720p/nope.m4s`, { headers })).status,
    ).toBe(404);
    expect((await fetch(`${t.baseUrl}/api/videos/${id}/h264_720p/init.mp4`)).status).toBe(401);
  });

  it('fails the job with a readable error for a non-video upload and marks the video failed', async () => {
    const id = await uploadFixture('not-a-video.mp4');
    const job = await waitFor(
      async () => (await t.app.db.jobs.list({ videoId: id })).items[0],
      (j) => j?.status === 'completed' || j?.status === 'failed',
      { timeoutMs: 60_000, intervalMs: 200 },
    );
    expect(job?.status).toBe('failed');
    expect(job?.error).toMatch(/unreadable source/);
    const { body: video } = await getJson<VideoView>(`/api/videos/${id}`);
    expect(video.status).toBe('failed');
    expect(video.error).toBe(job?.error);
    expect(video.renditions).toEqual([]);
  }, 90_000);
});
