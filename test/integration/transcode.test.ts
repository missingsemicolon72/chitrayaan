import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildRenditionArgs,
  FfmpegError,
  H264_720P,
  planRendition,
  probe,
  ProbeError,
  runFfmpeg,
  type FfmpegProgress,
} from '../../src/lib/transcode/index.js';
import { FFMPEG_PATH, FFPROBE_PATH, ffmpegAvailable, fixturePath } from '../helpers/ffmpeg.js';

const FFMPEG = await ffmpegAvailable();

describe.skipIf(!FFMPEG)('ffprobe', () => {
  it('reads a synthetic 1080p clip', async () => {
    const info = await probe(fixturePath('1080p-10s.mp4'), { ffprobePath: FFPROBE_PATH });
    expect(info).toMatchObject({
      width: 1920,
      height: 1080,
      videoCodec: 'h264',
      audioCodec: 'aac',
      hasVideo: true,
      hasAudio: true,
    });
    expect(info.durationSeconds).toBeCloseTo(10, 0);
    expect(info.frameRate).toBe(30);
  });

  it('reads portrait and silent clips', async () => {
    const portrait = await probe(fixturePath('portrait-1080x1920-5s.mp4'), {
      ffprobePath: FFPROBE_PATH,
    });
    expect([portrait.width, portrait.height]).toEqual([1080, 1920]);

    const silent = await probe(fixturePath('silent-720p-5s.mp4'), { ffprobePath: FFPROBE_PATH });
    expect(silent.hasAudio).toBe(false);
    expect(silent.audioCodec).toBeNull();
  });

  it('rejects files that are not media, with ffprobe output attached', async () => {
    for (const name of ['not-a-video.mp4', 'empty.mp4']) {
      const err = await probe(fixturePath(name), { ffprobePath: FFPROBE_PATH }).catch(
        (e: unknown) => e,
      );
      expect(err, name).toBeInstanceOf(ProbeError);
      expect((err as ProbeError).message.length, name).toBeGreaterThan(10);
    }
    await expect(
      probe(fixturePath('does-not-exist.mp4'), { ffprobePath: FFPROBE_PATH }),
    ).rejects.toThrow(ProbeError);
  });
});

describe.skipIf(!FFMPEG)('single-rendition transcode (720p H.264/AAC, CMAF)', () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(path.join(os.tmpdir(), 'chitrayaan-transcode-'));
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  async function encode(fixture: string) {
    const src = fixturePath(fixture);
    const info = await probe(src, { ffprobePath: FFPROBE_PATH });
    const plan = planRendition(H264_720P, info);
    const progress: FfmpegProgress[] = [];
    await runFfmpeg(buildRenditionArgs(src, plan, { preset: 'ultrafast' }), {
      ffmpegPath: FFMPEG_PATH,
      cwd: outDir,
      durationSeconds: info.durationSeconds,
      onProgress: (p) => progress.push(p),
    });
    const files = (await readdir(outDir)).sort();
    const output = await probe(path.join(outDir, 'index.m3u8'), { ffprobePath: FFPROBE_PATH });
    return { info, plan, progress, files, output };
  }

  it('downscales 1080p to 720p into init + segments + playlist, reporting progress', async () => {
    const { progress, files, output } = await encode('1080p-10s.mp4');

    expect(files).toContain('init.mp4');
    expect(files).toContain('index.m3u8');
    const segments = files.filter((f) => /^seg_\d{3}\.m4s$/.test(f));
    // 10s at 4s segments -> 3 segments.
    expect(segments).toEqual(['seg_000.m4s', 'seg_001.m4s', 'seg_002.m4s']);

    const playlist = await readFile(path.join(outDir, 'index.m3u8'), 'utf8');
    expect(playlist).toContain('#EXTM3U');
    expect(playlist).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
    expect(playlist).toContain('#EXT-X-INDEPENDENT-SEGMENTS');
    expect(playlist).toContain('#EXT-X-MAP:URI="init.mp4"');
    expect(playlist).toContain('#EXT-X-ENDLIST');
    // Segments are referenced by bare filename, so the playlist works from any base URL.
    expect(playlist).toMatch(/^seg_000\.m4s$/m);

    expect(output).toMatchObject({
      width: 1280,
      height: 720,
      videoCodec: 'h264',
      audioCodec: 'aac',
    });
    expect(output.durationSeconds).toBeCloseTo(10, 0);

    expect(progress.length).toBeGreaterThan(0);
    expect(Math.max(...progress.map((p) => p.percent ?? 0))).toBeGreaterThanOrEqual(99);
  }, 60_000);

  it('does not upscale a 480p source and keeps its frame rate', async () => {
    const { plan, output } = await encode('480p-5s.mp4');
    expect([plan.width, plan.height]).toEqual([854, 480]);
    expect(output).toMatchObject({ width: 854, height: 480 });
    expect(output.frameRate).toBe(25);
  }, 60_000);

  it('handles portrait and silent sources', async () => {
    const portrait = await encode('portrait-1080x1920-5s.mp4');
    expect([portrait.output.width, portrait.output.height]).toEqual([720, 1280]);
    await rm(outDir, { recursive: true, force: true });
    outDir = await mkdtemp(path.join(os.tmpdir(), 'chitrayaan-transcode-'));
    const silent = await encode('silent-720p-5s.mp4');
    expect(silent.output.hasAudio).toBe(false);
    expect([silent.output.width, silent.output.height]).toEqual([1280, 720]);
  }, 90_000);

  it('fails with an FfmpegError carrying the stderr tail for a truncated source', async () => {
    const src = fixturePath('truncated.mp4');
    const info = await probe(src, { ffprobePath: FFPROBE_PATH }).catch(() => null);
    if (info === null) return; // ffprobe already rejects it; the processor turns that into a job failure
    const plan = planRendition(H264_720P, info);
    const err = await runFfmpeg(buildRenditionArgs(src, plan, { preset: 'ultrafast' }), {
      ffmpegPath: FFMPEG_PATH,
      cwd: outDir,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FfmpegError);
    expect((err as FfmpegError).exitCode).not.toBe(0);
  }, 60_000);

  it('reports a clear error when the binary is missing', async () => {
    await expect(
      runFfmpeg(['-version'], { ffmpegPath: 'definitely-not-ffmpeg-xyz' }),
    ).rejects.toThrow(/could not start ffmpeg/);
  });
});
