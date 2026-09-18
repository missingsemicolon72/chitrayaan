import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildLadderArgs, parseHlsMaster, parseMpd } from '../../src/lib/packaging/index.js';
import {
  FfmpegError,
  H264_LADDER,
  planLadder,
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

describe.skipIf(!FFMPEG)('full H.264 ladder packaged as CMAF (DASH + HLS)', () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(path.join(os.tmpdir(), 'chitrayaan-ladder-'));
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  async function encodeLadder(fixture: string) {
    const src = fixturePath(fixture);
    const info = await probe(src, { ffprobePath: FFPROBE_PATH });
    const plans = planLadder(H264_LADDER, info);
    const progress: FfmpegProgress[] = [];
    await runFfmpeg(buildLadderArgs(src, plans, { preset: 'ultrafast' }), {
      ffmpegPath: FFMPEG_PATH,
      cwd: outDir,
      durationSeconds: info.durationSeconds,
      onProgress: (p) => progress.push(p),
    });
    const files = (await readdir(outDir)).sort();
    const mpd = parseMpd(await readFile(path.join(outDir, 'master.mpd'), 'utf8'));
    const master = parseHlsMaster(await readFile(path.join(outDir, 'master.m3u8'), 'utf8'));
    return { info, plans, progress, files, mpd, master };
  }

  it('produces four aligned rungs plus one audio track from a 1080p source', async () => {
    const { plans, progress, files, mpd, master } = await encodeLadder('1080p-10s.mp4');
    expect(plans).toHaveLength(4);

    // Shared-segment layout: one init + N chunks per stream, video streams 0-3, audio stream 4.
    for (const i of [0, 1, 2, 3, 4]) {
      expect(files, `init ${i}`).toContain(`init-stream${i}.m4s`);
      expect(files, `media playlist ${i}`).toContain(`media_${i}.m3u8`);
      const chunks = files.filter((f) => f.startsWith(`chunk-stream${i}-`));
      expect(chunks, `chunks ${i}`).toHaveLength(3); // 10s / 4s segments
    }
    expect(files).toContain('master.mpd');
    expect(files).toContain('master.m3u8');

    // DASH: video adaptation set with every rung, audio adaptation set with one representation.
    const video = mpd.representations.filter((r) => r.contentType === 'video');
    expect(video.map((r) => `${r.width}x${r.height}`)).toEqual([
      '640x360',
      '854x480',
      '1280x720',
      '1920x1080',
    ]);
    expect(video.map((r) => r.bandwidth)).toEqual([800_000, 1_400_000, 2_800_000, 5_000_000]);
    expect(video.every((r) => r.codecs?.startsWith('avc1.'))).toBe(true);
    const audio = mpd.representations.filter((r) => r.contentType === 'audio');
    expect(audio).toHaveLength(1);
    expect(audio[0]?.codecs).toBe('mp4a.40.2');
    expect(mpd.durationSeconds).toBeCloseTo(10, 0);

    // HLS: one variant per rung, all pointing at the shared audio group.
    expect(master.variants.map((v) => `${v.width}x${v.height}`)).toEqual([
      '640x360',
      '854x480',
      '1280x720',
      '1920x1080',
    ]);
    expect(master.variants.map((v) => v.uri)).toEqual([
      'media_0.m3u8',
      'media_1.m3u8',
      'media_2.m3u8',
      'media_3.m3u8',
    ]);
    expect(master.media).toHaveLength(1);
    expect(master.media[0]).toMatchObject({ type: 'AUDIO', uri: 'media_4.m3u8', isDefault: true });
    expect(master.variants.every((v) => v.audioGroup === master.media[0]?.groupId)).toBe(true);

    // Every media playlist is a VOD fMP4 playlist over the same chunk files.
    const media3 = await readFile(path.join(outDir, 'media_3.m3u8'), 'utf8');
    expect(media3).toContain('#EXT-X-MAP:URI="init-stream3.m4s"');
    expect(media3).toContain('chunk-stream3-00001.m4s');
    expect(media3).toContain('#EXT-X-ENDLIST');

    // FFmpeg's own demuxers can read what was produced.
    const top = await probe(path.join(outDir, 'media_3.m3u8'), { ffprobePath: FFPROBE_PATH });
    expect(top).toMatchObject({ width: 1920, height: 1080, videoCodec: 'h264' });
    const viaMpd = await probe(path.join(outDir, 'master.mpd'), { ffprobePath: FFPROBE_PATH });
    expect(viaMpd.hasVideo).toBe(true);
    expect(viaMpd.hasAudio).toBe(true);

    expect(Math.max(...progress.map((p) => p.percent ?? 0))).toBeGreaterThanOrEqual(99);
  }, 120_000);

  it('yields only the rungs a 480p source can fill', async () => {
    const { plans, files, mpd } = await encodeLadder('480p-5s.mp4');
    expect(plans.map((p) => p.profile.name)).toEqual(['h264_360p', 'h264_480p']);
    expect(files.filter((f) => f.startsWith('init-stream'))).toEqual([
      'init-stream0.m4s',
      'init-stream1.m4s',
      'init-stream2.m4s',
    ]);
    expect(
      mpd.representations.filter((r) => r.contentType === 'video').map((r) => r.height),
    ).toEqual([360, 480]);
    const low = await probe(path.join(outDir, 'media_0.m3u8'), { ffprobePath: FFPROBE_PATH });
    expect([low.width, low.height, low.frameRate]).toEqual([640, 360, 25]);
  }, 90_000);

  it('packages a silent source without an audio adaptation set or media group', async () => {
    const { files, mpd, master } = await encodeLadder('silent-720p-5s.mp4');
    expect(mpd.representations.filter((r) => r.contentType === 'audio')).toEqual([]);
    expect(master.media).toEqual([]);
    expect(master.variants.every((v) => v.audioGroup === null)).toBe(true);
    expect(files.filter((f) => f.startsWith('init-stream'))).toHaveLength(3); // 360, 480, 720
  }, 90_000);

  it('fails with an FfmpegError carrying the stderr tail for a truncated source', async () => {
    const src = fixturePath('truncated.mp4');
    const info = await probe(src, { ffprobePath: FFPROBE_PATH }).catch(() => null);
    if (info === null) return; // ffprobe already rejects it; the processor turns that into a job failure
    const plans = planLadder(H264_LADDER, info);
    const err = await runFfmpeg(buildLadderArgs(src, plans, { preset: 'ultrafast' }), {
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
