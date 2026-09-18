import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  buildRenditionArgs,
  H264_720P,
  planRendition,
  probe,
  runFfmpeg,
} from '../../src/lib/transcode/index.js';
import { FFMPEG_PATH, FFPROBE_PATH, ffmpegAvailable } from '../helpers/ffmpeg.js';

/**
 * Milestone-completion validation against the owner's real clips (CLAUDE.md decision #15).
 * Opt-in because real files are slow to encode: `RUN_SAMPLE_TESTS=1 npm test -- samples`.
 */
const SAMPLES_DIR = path.resolve(process.env.TEST_SAMPLES_DIR ?? './test/samples');
const MEDIA = /\.(mp4|mov|mkv|webm|avi|m4v|ts|flv)$/i;

const enabled = process.env.RUN_SAMPLE_TESTS === '1' && (await ffmpegAvailable());
const samples = enabled
  ? (await readdir(SAMPLES_DIR).catch(() => [] as string[])).filter((f) => MEDIA.test(f)).sort()
  : [];

if (process.env.RUN_SAMPLE_TESTS === '1' && samples.length === 0) {
  console.warn(`[samples] no media files found in ${SAMPLES_DIR}`);
}

describe.skipIf(samples.length === 0)('real sample clips -> 720p CMAF rendition', () => {
  for (const name of samples) {
    it(
      `transcodes ${name}`,
      async () => {
        const src = path.join(SAMPLES_DIR, name);
        const outDir = await mkdtemp(path.join(os.tmpdir(), 'chitrayaan-sample-'));
        try {
          const info = await probe(src, { ffprobePath: FFPROBE_PATH });
          expect(info.hasVideo, 'sample has a video stream').toBe(true);
          const plan = planRendition(H264_720P, info);
          const started = Date.now();
          await runFfmpeg(buildRenditionArgs(src, plan, { preset: 'veryfast' }), {
            ffmpegPath: FFMPEG_PATH,
            cwd: outDir,
            durationSeconds: info.durationSeconds,
          });
          const output = await probe(path.join(outDir, 'index.m3u8'), {
            ffprobePath: FFPROBE_PATH,
          });
          console.log(
            `[samples] ${name}: ${info.width}x${info.height} ${info.durationSeconds.toFixed(1)}s -> ` +
              `${output.width}x${output.height} in ${((Date.now() - started) / 1000).toFixed(1)}s`,
          );
          expect(output.videoCodec).toBe('h264');
          expect(Math.min(output.width ?? 0, output.height ?? 0)).toBeLessThanOrEqual(720);
          expect(output.durationSeconds).toBeCloseTo(info.durationSeconds, 0);
          if (info.hasAudio) expect(output.audioCodec).toBe('aac');
        } finally {
          await rm(outDir, { recursive: true, force: true });
        }
      },
      30 * 60_000,
    );
  }
});
