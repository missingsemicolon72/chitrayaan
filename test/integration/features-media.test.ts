import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseWebVtt } from '../../src/lib/features/subtitles/index.js';
import {
  generateThumbnails,
  THUMBNAIL_TRACK_FILE,
} from '../../src/lib/features/thumbnails/index.js';
import { buildLadderArgs } from '../../src/lib/packaging/index.js';
import {
  H264_LADDER,
  planLadder,
  probe,
  probeImageSize,
  runFfmpeg,
} from '../../src/lib/transcode/index.js';
import { FFMPEG_PATH, FFPROBE_PATH, ffmpegAvailable, fixturePath } from '../helpers/ffmpeg.js';

const FFMPEG = await ffmpegAvailable();
const silent = pino({ level: 'silent' });

/** Average luma of a cropped region of the first frame, read as raw grayscale bytes. */
function regionLuma(file: string, crop: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      FFMPEG_PATH,
      [
        '-v',
        'error',
        '-i',
        file,
        '-frames:v',
        '1',
        '-vf',
        `crop=${crop},format=gray`,
        '-f',
        'rawvideo',
        '-',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    const chunks: Buffer[] = [];
    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.once('error', reject);
    child.once('close', (code) => {
      const bytes = Buffer.concat(chunks);
      if (code !== 0 || bytes.length === 0) {
        reject(new Error(`could not sample ${file} (exit ${String(code)})`));
        return;
      }
      let sum = 0;
      for (const b of bytes) sum += b;
      resolve(sum / bytes.length);
    });
  });
}

describe.skipIf(!FFMPEG)('thumbnail sprites', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(os.tmpdir(), 'chitrayaan-thumbs-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('extracts previews, tiles them, and writes a matching WebVTT track', async () => {
    const source = fixturePath('1080p-10s.mp4');
    const assets = await generateThumbnails({
      ffmpegPath: FFMPEG_PATH,
      ffprobePath: FFPROBE_PATH,
      sourcePath: source,
      workDir,
      durationSeconds: 10,
      log: silent,
    });

    // 10s at the 2s minimum interval -> 5 previews on one sheet.
    expect(assets.intervalSeconds).toBe(2);
    expect(assets.thumbnailCount).toBe(5);
    expect(assets.spriteCount).toBe(1);
    expect([assets.tileWidth, assets.tileHeight]).toEqual([160, 90]);
    expect(assets.files.sort()).toEqual(['sprite_000.jpg', THUMBNAIL_TRACK_FILE]);

    // The sheet is exactly the grid of tiles the cues point into.
    const sprite = await probeImageSize(path.join(assets.outputDir, 'sprite_000.jpg'), {
      ffprobePath: FFPROBE_PATH,
    });
    expect(sprite).toEqual({ width: 5 * 160, height: 90 });

    const track = await readFile(path.join(assets.outputDir, THUMBNAIL_TRACK_FILE), 'utf8');
    expect(parseWebVtt(track).cueCount).toBe(5);
    expect(track).toContain('00:00:00.000 --> 00:00:02.000\nsprite_000.jpg#xywh=0,0,160,90');
    expect(track).toContain('sprite_000.jpg#xywh=640,0,160,90');
    // Every cue points inside the sheet.
    for (const [, x, w] of track.matchAll(/#xywh=(\d+),\d+,(\d+),\d+/g)) {
      expect(Number(x) + Number(w)).toBeLessThanOrEqual(sprite.width);
    }

    // Intermediate frames stay out of the publishable directory.
    expect((await readdir(assets.outputDir)).some((f) => f.startsWith('thumb_'))).toBe(false);
  }, 90_000);

  it('keeps the source aspect ratio for a portrait video', async () => {
    const assets = await generateThumbnails({
      ffmpegPath: FFMPEG_PATH,
      ffprobePath: FFPROBE_PATH,
      sourcePath: fixturePath('portrait-1080x1920-5s.mp4'),
      workDir,
      durationSeconds: 5,
      log: silent,
    });
    expect(assets.tileWidth).toBe(160);
    expect(assets.tileHeight).toBeGreaterThan(assets.tileWidth);
    expect(assets.thumbnailCount).toBe(3);
    const sprite = await probeImageSize(path.join(assets.outputDir, 'sprite_000.jpg'), {
      ffprobePath: FFPROBE_PATH,
    });
    expect(sprite.width).toBe(3 * assets.tileWidth);
    expect(sprite.height).toBe(assets.tileHeight);
  }, 90_000);
});

describe.skipIf(!FFMPEG)('watermark overlay', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'chitrayaan-wm-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function encode(outName: string, watermark?: { imagePath: string; opacity: number }) {
    const outDir = path.join(dir, outName);
    await rm(outDir, { recursive: true, force: true });
    const source = fixturePath('480p-5s.mp4');
    const info = await probe(source, { ffprobePath: FFPROBE_PATH });
    const plans = planLadder(H264_LADDER, info);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(outDir, { recursive: true });
    await runFfmpeg(
      buildLadderArgs(source, plans, {
        preset: 'ultrafast',
        ...(watermark
          ? {
              watermark: {
                imagePath: watermark.imagePath,
                position: 'bottom-right' as const,
                opacity: watermark.opacity,
              },
            }
          : {}),
      }),
      { ffmpegPath: FFMPEG_PATH, cwd: outDir },
    );
    return outDir;
  }

  it('burns a logo into every rung without disturbing the rest of the frame', async () => {
    // A plain white block, big enough to measure against the test pattern behind it.
    const logo = path.join(dir, 'logo.png');
    await runFfmpeg(
      ['-y', '-f', 'lavfi', '-i', 'color=c=white:s=240x80:d=1', '-frames:v', '1', logo],
      { ffmpegPath: FFMPEG_PATH },
    );

    const cleanDir = await encode('clean');
    const markedDir = await encode('marked', { imagePath: logo, opacity: 1 });

    // Bottom-right of the 854x480 rung, inside where the logo lands.
    const corner = '200:60:610:400';
    const topLeft = '200:60:20:20';
    const [cleanCorner, markedCorner] = await Promise.all([
      regionLuma(path.join(cleanDir, 'media_1.m3u8'), corner),
      regionLuma(path.join(markedDir, 'media_1.m3u8'), corner),
    ]);
    expect(markedCorner).toBeGreaterThan(cleanCorner + 10);

    // The opposite corner is untouched by a bottom-right watermark.
    const [cleanTop, markedTop] = await Promise.all([
      regionLuma(path.join(cleanDir, 'media_1.m3u8'), topLeft),
      regionLuma(path.join(markedDir, 'media_1.m3u8'), topLeft),
    ]);
    expect(Math.abs(markedTop - cleanTop)).toBeLessThan(6);

    // The lower rung is watermarked too: the overlay happens before the ladder split.
    const lowCorner = await regionLuma(path.join(markedDir, 'media_0.m3u8'), '140:40:460:300');
    const lowClean = await regionLuma(path.join(cleanDir, 'media_0.m3u8'), '140:40:460:300');
    expect(lowCorner).toBeGreaterThan(lowClean + 10);

    // Packaging is unaffected: the same file set as an unwatermarked run.
    expect((await readdir(markedDir)).sort()).toEqual((await readdir(cleanDir)).sort());
  }, 180_000);

  it('applies opacity: a half-transparent logo lands between clean and opaque', async () => {
    const logo = path.join(dir, 'logo.png');
    await runFfmpeg(
      ['-y', '-f', 'lavfi', '-i', 'color=c=white:s=240x80:d=1', '-frames:v', '1', logo],
      { ffmpegPath: FFMPEG_PATH },
    );
    const corner = '200:60:610:400';
    const [clean, half, full] = [
      await encode('c', undefined),
      await encode('h', { imagePath: logo, opacity: 0.5 }),
      await encode('f', { imagePath: logo, opacity: 1 }),
    ];
    const [cleanLuma, halfLuma, fullLuma] = await Promise.all([
      regionLuma(path.join(clean, 'media_1.m3u8'), corner),
      regionLuma(path.join(half, 'media_1.m3u8'), corner),
      regionLuma(path.join(full, 'media_1.m3u8'), corner),
    ]);
    expect(halfLuma).toBeGreaterThan(cleanLuma + 5);
    expect(fullLuma).toBeGreaterThan(halfLuma + 5);
  }, 240_000);
});
