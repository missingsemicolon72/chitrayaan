import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildLadderArgs, parseMpd } from '../../src/lib/packaging/index.js';
import { H264_LADDER, planLadder, probe, runFfmpeg } from '../../src/lib/transcode/index.js';
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

describe.skipIf(samples.length === 0)('real sample clips -> full ladder, DASH + HLS', () => {
  for (const name of samples) {
    it(
      `packages ${name}`,
      async () => {
        const src = path.join(SAMPLES_DIR, name);
        const outDir = await mkdtemp(path.join(os.tmpdir(), 'chitrayaan-sample-'));
        try {
          const info = await probe(src, { ffprobePath: FFPROBE_PATH });
          expect(info.hasVideo, 'sample has a video stream').toBe(true);
          const plans = planLadder(H264_LADDER, info);
          const started = Date.now();
          await runFfmpeg(buildLadderArgs(src, plans, { preset: 'veryfast' }), {
            ffmpegPath: FFMPEG_PATH,
            cwd: outDir,
            durationSeconds: info.durationSeconds,
          });
          const mpd = parseMpd(await readFile(path.join(outDir, 'master.mpd'), 'utf8'));
          const video = mpd.representations.filter((r) => r.contentType === 'video');
          console.log(
            `[samples] ${name}: ${info.width}x${info.height} @${info.frameRate ?? '?'}fps ` +
              `${info.durationSeconds.toFixed(1)}s -> ${video.map((r) => `${r.width}x${r.height}`).join(', ')} ` +
              `in ${((Date.now() - started) / 1000).toFixed(1)}s`,
          );
          expect(video).toHaveLength(plans.length);
          const top = await probe(path.join(outDir, `media_${plans.length - 1}.m3u8`), {
            ffprobePath: FFPROBE_PATH,
          });
          expect(top.videoCodec).toBe('h264');
          expect(top.durationSeconds).toBeCloseTo(info.durationSeconds, 0);
          if (info.hasAudio)
            expect(mpd.representations.some((r) => r.contentType === 'audio')).toBe(true);
        } finally {
          await rm(outDir, { recursive: true, force: true });
        }
      },
      30 * 60_000,
    );
  }
});
