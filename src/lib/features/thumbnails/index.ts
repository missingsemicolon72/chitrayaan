import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Logger } from '../../logger.js';
import { probeImageSize, runFfmpeg } from '../../transcode/index.js';
import { formatVttTimestamp } from '../webvtt.js';

/** Width of a single preview tile; the height follows the source aspect ratio. */
export const THUMBNAIL_WIDTH = 160;
/** Columns in a sprite sheet, and the most rows one sheet may have. */
export const SPRITE_COLUMNS = 10;
export const SPRITE_MAX_ROWS = 10;
/** Never sample more often than this, however short the video. */
export const MIN_INTERVAL_SECONDS = 2;
/** Soft cap on the number of previews, which sets the interval for long videos. */
export const TARGET_MAX_THUMBNAILS = 200;

export const THUMBNAIL_TRACK_FILE = 'thumbnails.vtt';
/** Storage sub-prefix under `videos/<id>/`. */
export const THUMBNAILS_PREFIX = 'thumbs';

export function spriteFileName(sheet: number): string {
  return `sprite_${String(sheet).padStart(3, '0')}.jpg`;
}

/** Seconds between previews: coarser for long videos so the sprite set stays small. */
export function thumbnailInterval(durationSeconds: number): number {
  return Math.max(MIN_INTERVAL_SECONDS, Math.ceil(durationSeconds / TARGET_MAX_THUMBNAILS));
}

export interface SpriteGrid {
  columns: number;
  rows: number;
  perSheet: number;
  sheets: number;
}

/** Lay `count` tiles out into as few full sheets as possible. */
export function spriteGrid(count: number): SpriteGrid {
  const tiles = Math.max(1, count);
  const columns = Math.min(SPRITE_COLUMNS, tiles);
  const rows = Math.min(SPRITE_MAX_ROWS, Math.ceil(tiles / columns));
  const perSheet = columns * rows;
  return { columns, rows, perSheet, sheets: Math.ceil(tiles / perSheet) };
}

/** FFmpeg args that write one JPEG per interval into the current working directory. */
export function buildExtractArgs(sourcePath: string, intervalSeconds: number): string[] {
  return [
    '-y',
    '-i',
    sourcePath,
    '-vf',
    `fps=1/${intervalSeconds},scale=${THUMBNAIL_WIDTH}:-2`,
    '-q:v',
    '5',
    '-an',
    'thumb_%04d.jpg',
  ];
}

/** FFmpeg args that tile `thumb_%04d.jpg` (numbered from 1) into `sprite_NNN.jpg` sheets. */
export function buildSpriteArgs(grid: SpriteGrid, sourceDir: string): string[] {
  return [
    '-y',
    '-framerate',
    '1',
    '-start_number',
    '1',
    '-i',
    path.join(sourceDir, 'thumb_%04d.jpg'),
    '-vf',
    `tile=${grid.columns}x${grid.rows}`,
    '-q:v',
    '5',
    '-start_number',
    '0',
    spriteFileName(0).replace('000', '%03d'),
  ];
}

export interface ThumbnailTrackOptions {
  count: number;
  intervalSeconds: number;
  durationSeconds: number;
  grid: SpriteGrid;
  tileWidth: number;
  tileHeight: number;
}

/**
 * The WebVTT scrubbing track: one cue per interval whose payload is a sprite URL with a
 * `#xywh=` media fragment, the format players use for hover previews.
 */
export function buildThumbnailTrack(options: ThumbnailTrackOptions): string {
  const { count, intervalSeconds, durationSeconds, grid, tileWidth, tileHeight } = options;
  const lines = ['WEBVTT', ''];
  for (let i = 0; i < count; i += 1) {
    const start = i * intervalSeconds;
    const end = Math.min((i + 1) * intervalSeconds, Math.max(durationSeconds, start + 0.001));
    const sheet = Math.floor(i / grid.perSheet);
    const indexInSheet = i % grid.perSheet;
    const x = (indexInSheet % grid.columns) * tileWidth;
    const y = Math.floor(indexInSheet / grid.columns) * tileHeight;
    lines.push(
      `${formatVttTimestamp(start)} --> ${formatVttTimestamp(end)}`,
      `${spriteFileName(sheet)}#xywh=${x},${y},${tileWidth},${tileHeight}`,
      '',
    );
  }
  return lines.join('\n');
}

export interface GenerateThumbnailsOptions {
  ffmpegPath: string;
  ffprobePath: string;
  sourcePath: string;
  /** Scratch directory; intermediates and the publishable output live in subdirectories. */
  workDir: string;
  durationSeconds: number;
  /** Shares the job's deadline, so a hung extraction is killed with everything else. */
  signal?: AbortSignal;
  log: Logger;
}

export interface ThumbnailAssets {
  /** Directory holding only the files to publish: the sprites and the WebVTT track. */
  outputDir: string;
  files: string[];
  spriteCount: number;
  thumbnailCount: number;
  intervalSeconds: number;
  tileWidth: number;
  tileHeight: number;
}

/**
 * Extract previews, tile them into sprite sheets, and write the WebVTT track. Two cheap FFmpeg
 * passes rather than one clever filter graph: the tile count is then exact, because it comes
 * from the files that were actually written.
 */
export async function generateThumbnails(
  options: GenerateThumbnailsOptions,
): Promise<ThumbnailAssets> {
  const framesDir = path.join(options.workDir, 'thumb-frames');
  const outputDir = path.join(options.workDir, THUMBNAILS_PREFIX);
  await mkdir(framesDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });

  const intervalSeconds = thumbnailInterval(options.durationSeconds);
  await runFfmpeg(buildExtractArgs(options.sourcePath, intervalSeconds), {
    ffmpegPath: options.ffmpegPath,
    cwd: framesDir,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  const frames = (await readdir(framesDir)).filter((f) => f.startsWith('thumb_')).sort();
  if (frames.length === 0) throw new Error('thumbnail extraction produced no frames');
  const tile = await probeImageSize(path.join(framesDir, frames[0]!), {
    ffprobePath: options.ffprobePath,
  });

  const grid = spriteGrid(frames.length);
  await runFfmpeg(buildSpriteArgs(grid, framesDir), {
    ffmpegPath: options.ffmpegPath,
    cwd: outputDir,
    ...(options.signal ? { signal: options.signal } : {}),
  });

  await writeFile(
    path.join(outputDir, THUMBNAIL_TRACK_FILE),
    buildThumbnailTrack({
      count: frames.length,
      intervalSeconds,
      durationSeconds: options.durationSeconds,
      grid,
      tileWidth: tile.width,
      tileHeight: tile.height,
    }),
    'utf8',
  );

  const files = (await readdir(outputDir)).sort();
  const spriteCount = files.filter((f) => f.startsWith('sprite_')).length;
  options.log.info(
    { thumbnails: frames.length, sprites: spriteCount, intervalSeconds, tile },
    'thumbnail sprites generated',
  );
  return {
    outputDir,
    files,
    spriteCount,
    thumbnailCount: frames.length,
    intervalSeconds,
    tileWidth: tile.width,
    tileHeight: tile.height,
  };
}
