import { spawn } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
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
import { FFMPEG_PATH, FFPROBE_PATH, ffmpegAvailable } from '../helpers/ffmpeg.js';
import { redisAvailable, TEST_REDIS_URL } from '../helpers/redis.js';
import { waitFor } from '../helpers/wait.js';

/**
 * Milestone-completion validation against the owner's real clips (CLAUDE.md decision #15):
 * the whole pipe, upload to playback, on files that were not produced by this project.
 * Opt in with `RUN_SAMPLE_TESTS=1 npm test -- samples`; it is slow by design.
 */
const SAMPLES_DIR = path.resolve(process.env.TEST_SAMPLES_DIR ?? './test/samples');
const MEDIA = /\.(mp4|mov|mkv|webm|avi|m4v|ts|flv)$/i;

const enabled =
  process.env.RUN_SAMPLE_TESTS === '1' && (await ffmpegAvailable()) && (await redisAvailable());
const samples = enabled
  ? (await readdir(SAMPLES_DIR).catch(() => [] as string[])).filter((f) => MEDIA.test(f)).sort()
  : [];

if (process.env.RUN_SAMPLE_TESTS === '1' && samples.length === 0) {
  console.warn(`[samples] nothing to run: no media in ${SAMPLES_DIR}, or FFmpeg/Redis missing`);
}

interface VideoView extends Video {
  jobs: { id: string; status: string; progress: number; error: string | null }[];
  manifests: { hls: string | null; dash: string | null };
  renditions: (Rendition & { playlistUrl: string | null })[];
  thumbnails: { trackUrl: string; spriteCount: number } | null;
}

interface ProbedUrl {
  durationSeconds: number;
  streams: { codec: string; size: string }[];
}

/** ffprobe a URL that needs the API key: proof a player could actually open it. */
function probeUrl(url: string, apiKey: string): Promise<ProbedUrl> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      FFPROBE_PATH,
      [
        '-v',
        'error',
        '-headers',
        `X-API-Key: ${apiKey}`,
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        url,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (err += c.toString()));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe failed for ${url}: ${err.trim().split('\n').at(-1) ?? ''}`));
        return;
      }
      const parsed = JSON.parse(out) as {
        format?: { duration?: string };
        streams?: { codec_name?: string; width?: number; height?: number }[];
      };
      resolve({
        durationSeconds: Number(parsed.format?.duration ?? 0),
        streams: (parsed.streams ?? []).map((s) => ({
          codec: s.codec_name ?? '',
          size: s.width && s.height ? `${s.width}x${s.height}` : 'audio',
        })),
      });
    });
  });
}

describe.skipIf(samples.length === 0)('real sample clips, end to end', () => {
  let t: TestApp;
  let worker: TranscodeWorkerHandle;

  beforeAll(async () => {
    t = await createTestApp({
      listen: true,
      env: { FEATURE_THUMBNAILS: 'true', FEATURE_SUBTITLES: 'true' },
    });
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
          preset: 'veryfast',
          thumbnails: true,
        }),
      }),
    });
  });

  afterAll(async () => {
    await worker.close();
    await t.close();
  });

  for (const name of samples) {
    it(
      `uploads, transcodes and serves ${name}`,
      async () => {
        const file = path.join(SAMPLES_DIR, name);
        const sizeBytes = (await stat(file)).size;
        const headers = { 'X-API-Key': t.apiKey };

        const started = Date.now();
        const data = await readFile(file);
        const id = await new Promise<string>((resolve, reject) => {
          const upload = new TusClientUpload(data, {
            endpoint: `${t.baseUrl}/api/uploads`,
            chunkSize: 5 * 1024 * 1024,
            retryDelays: [0, 200],
            headers,
            metadata: { filename: name },
            storeFingerprintForResuming: false,
            onError: reject,
            onSuccess: () => resolve(upload.url!.split('/').pop()!),
          });
          upload.start();
        });

        const job = await waitFor(
          async () => (await t.app.db.jobs.list({ videoId: id })).items[0],
          (j) => j?.status === 'completed' || j?.status === 'failed',
          { timeoutMs: 20 * 60_000, intervalMs: 1_000 },
        );
        expect(job?.error).toBeNull();
        expect(job?.status).toBe('completed');

        const res = await fetch(`${t.baseUrl}/api/videos/${id}`, { headers });
        const video = (await res.json()) as VideoView;
        expect(video.status).toBe('ready');
        expect(video.sizeBytes).toBe(sizeBytes);

        // Every rung is capped at the source resolution and none is duplicated.
        const shortSide = Math.min(video.width ?? 0, video.height ?? 0);
        expect(video.renditions.length).toBeGreaterThan(0);
        for (const rendition of video.renditions) {
          expect(Math.min(rendition.width, rendition.height)).toBeLessThanOrEqual(shortSide);
          expect(rendition.segmentCount).toBeGreaterThan(0);
          expect(rendition.sizeBytes ?? 0).toBeGreaterThan(0);
        }
        expect(new Set(video.renditions.map((r) => `${r.width}x${r.height}`)).size).toBe(
          video.renditions.length,
        );

        // Both manifests list exactly those renditions...
        const master = parseHlsMaster(
          await (await fetch(`${t.baseUrl}${video.manifests.hls!}`, { headers })).text(),
        );
        expect(master.variants).toHaveLength(video.renditions.length);
        const mpd = parseMpd(
          await (await fetch(`${t.baseUrl}${video.manifests.dash!}`, { headers })).text(),
        );
        expect(mpd.representations.filter((r) => r.contentType === 'video')).toHaveLength(
          video.renditions.length,
        );
        // FFmpeg's DASH muxer rounds mediaPresentationDuration down to a whole second, and a
        // container's duration is its longest stream (these samples' audio outruns their video),
        // so the manifest attribute only has to be in the right neighbourhood.
        const sourceDuration = video.durationSeconds ?? 0;
        expect(mpd.durationSeconds).toBeGreaterThan(sourceDuration - 1.5);
        expect(mpd.durationSeconds).toBeLessThanOrEqual(sourceDuration + 0.5);

        // ...and FFmpeg can play both of them back over HTTP, with the content intact.
        const viaHls = await probeUrl(`${t.baseUrl}${video.manifests.hls!}`, t.apiKey);
        const viaDash = await probeUrl(`${t.baseUrl}${video.manifests.dash!}`, t.apiKey);
        const topRendition = video.renditions.at(-1)!;
        for (const [label, probed] of [
          ['hls', viaHls],
          ['dash', viaDash],
        ] as const) {
          expect(
            probed.streams.some((s) => s.codec === 'h264'),
            label,
          ).toBe(true);
          expect(
            probed.streams.some((s) => s.codec === 'aac'),
            label,
          ).toBe(true);
          expect(
            probed.streams.some((s) => s.size === `${topRendition.width}x${topRendition.height}`),
            label,
          ).toBe(true);
          // Nothing was dropped: the playable stream is as long as the source.
          expect(probed.durationSeconds, label).toBeGreaterThan(sourceDuration - 1);
        }

        // Scrubbing previews came out too.
        expect(video.thumbnails?.spriteCount).toBeGreaterThan(0);
        const track = await fetch(`${t.baseUrl}${video.thumbnails!.trackUrl}`, { headers });
        expect(track.status).toBe(200);
        expect((await track.text()).startsWith('WEBVTT')).toBe(true);

        console.log(
          `[samples] ${name}: ${(sizeBytes / 1048576).toFixed(1)} MiB ${video.width}x${video.height} ` +
            `${(video.durationSeconds ?? 0).toFixed(1)}s -> ${video.renditions.map((r) => r.name.replace('h264_', '')).join(', ')} ` +
            `in ${((Date.now() - started) / 1000).toFixed(1)}s`,
        );
      },
      25 * 60_000,
    );
  }
});
