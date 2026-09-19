import { describe, expect, it } from 'vitest';

import {
  assertSubtitleSize,
  buildSubtitlePlaylist,
  defaultLabel,
  formatVttTimestamp,
  InvalidLanguageError,
  InvalidWebVttError,
  normalizeLanguage,
  parseVttTimestamp,
  parseWebVtt,
  subtitleKey,
  SUBTITLE_MAX_BYTES,
} from '../../src/lib/features/subtitles/index.js';
import {
  buildExtractArgs,
  buildSpriteArgs,
  buildThumbnailTrack,
  spriteFileName,
  spriteGrid,
  thumbnailInterval,
  THUMBNAIL_WIDTH,
} from '../../src/lib/features/thumbnails/index.js';
import {
  buildWatermarkChain,
  overlayPosition,
  WATERMARK_MARGIN_RATIO,
} from '../../src/lib/features/watermark/index.js';

const VALID_VTT = `WEBVTT

1
00:00:01.000 --> 00:00:03.500
Hello there

2
00:00:04.000 --> 00:00:06.250 line:90%
Second cue
`;

describe('WebVTT timestamps', () => {
  it('parses both hh:mm:ss.mmm and mm:ss.mmm', () => {
    expect(parseVttTimestamp('00:00:01.000')).toBe(1);
    expect(parseVttTimestamp('01:02:03.250')).toBe(3723.25);
    expect(parseVttTimestamp('02:03.500')).toBe(123.5);
    expect(parseVttTimestamp('nope')).toBeNull();
    expect(parseVttTimestamp('00:60:00.000')).toBeNull();
  });

  it('formats seconds back into cue timestamps', () => {
    expect(formatVttTimestamp(0)).toBe('00:00:00.000');
    expect(formatVttTimestamp(3723.25)).toBe('01:02:03.250');
    expect(formatVttTimestamp(-5)).toBe('00:00:00.000');
  });
});

describe('parseWebVtt', () => {
  it('counts cues and reports the last end time', () => {
    expect(parseWebVtt(VALID_VTT)).toEqual({ cueCount: 2, lastCueEndSeconds: 6.25 });
  });

  it('accepts a BOM, CRLF line endings, and a header comment', () => {
    // Built from a char code so the marker cannot be lost when this file is edited.
    const bom = String.fromCharCode(0xfeff);
    const withBom = `${bom}WEBVTT - subtitles\r\n\r\n00:00:00.000 --> 00:00:01.000\r\nhi\r\n`;
    expect(withBom.charCodeAt(0)).toBe(0xfeff);
    expect(parseWebVtt(withBom).cueCount).toBe(1);
  });

  it('rejects a missing header, bad timings, and files without cues', () => {
    expect(() => parseWebVtt('NOT A VTT\n\n00:00:00.000 --> 00:00:01.000\nx')).toThrow(
      /WEBVTT header/,
    );
    expect(() => parseWebVtt('WEBVTT\n\nhello\n')).toThrow(/no cues/);
    expect(() => parseWebVtt('WEBVTT\n\n0:0 --> 1\nx\n')).toThrow(/malformed cue timing/);
    expect(() => parseWebVtt('WEBVTT\n\n00:00:05.000 --> 00:00:01.000\nx\n')).toThrow(
      /ends before it starts/,
    );
    expect(() => parseWebVtt('WEBVTT\n\nx')).toThrow(InvalidWebVttError);
  });
});

describe('subtitle helpers', () => {
  it('normalises language tags and rejects junk', () => {
    expect(normalizeLanguage('EN')).toBe('en');
    expect(normalizeLanguage('pt-br')).toBe('pt-BR');
    expect(normalizeLanguage(' fr-CA ')).toBe('fr-CA');
    expect(normalizeLanguage('zh-Hans')).toBe('zh-hans');
    for (const bad of ['', 'e', 'english!', '../etc', 'en_US', '12']) {
      expect(() => normalizeLanguage(bad), bad).toThrow(InvalidLanguageError);
    }
  });

  it('builds storage keys and human labels', () => {
    expect(subtitleKey('vid-1', 'en')).toBe('videos/vid-1/subtitles/en.vtt');
    expect(defaultLabel('en').length).toBeGreaterThan(0);
  });

  it('enforces the size limits', () => {
    expect(() => assertSubtitleSize(0)).toThrow(/empty/);
    expect(() => assertSubtitleSize(SUBTITLE_MAX_BYTES + 1)).toThrow(/larger than/);
    expect(() => assertSubtitleSize(1024)).not.toThrow();
  });

  it('wraps a track in an HLS media playlist pointing at the sibling .vtt', () => {
    const playlist = buildSubtitlePlaylist('pt-BR', 12.5);
    expect(playlist).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
    expect(playlist).toContain('#EXT-X-TARGETDURATION:13');
    expect(playlist).toContain('#EXTINF:12.500,');
    expect(playlist).toContain('pt-BR.vtt');
    expect(playlist).toContain('#EXT-X-ENDLIST');
  });
});

describe('thumbnail planning', () => {
  it('samples every 2s for short videos and stretches the interval for long ones', () => {
    expect(thumbnailInterval(10)).toBe(2);
    expect(thumbnailInterval(300)).toBe(2);
    expect(thumbnailInterval(3600)).toBe(18);
    expect(thumbnailInterval(7200)).toBe(36);
  });

  it('lays tiles out into as few full sheets as possible', () => {
    expect(spriteGrid(5)).toEqual({ columns: 5, rows: 1, perSheet: 5, sheets: 1 });
    expect(spriteGrid(10)).toEqual({ columns: 10, rows: 1, perSheet: 10, sheets: 1 });
    expect(spriteGrid(25)).toEqual({ columns: 10, rows: 3, perSheet: 30, sheets: 1 });
    expect(spriteGrid(105)).toEqual({ columns: 10, rows: 10, perSheet: 100, sheets: 2 });
    expect(spriteGrid(0)).toEqual({ columns: 1, rows: 1, perSheet: 1, sheets: 1 });
  });

  it('builds extraction and tiling arguments', () => {
    const extract = buildExtractArgs('/in/src.mp4', 4).join(' ');
    expect(extract).toContain('-i /in/src.mp4');
    expect(extract).toContain(`-vf fps=1/4,scale=${THUMBNAIL_WIDTH}:-2`);
    expect(extract).toContain('thumb_%04d.jpg');

    const sprite = buildSpriteArgs(spriteGrid(5), '/tmp/frames').join(' ');
    expect(sprite).toContain('-framerate 1 -start_number 1');
    expect(sprite).toContain('-vf tile=5x1');
    // Sheets are numbered from zero; FFmpeg's image muxer would otherwise start at one.
    expect(sprite).toContain('-start_number 0 sprite_%03d.jpg');
  });

  it('writes one cue per preview with sprite coordinates', () => {
    const track = buildThumbnailTrack({
      count: 5,
      intervalSeconds: 2,
      durationSeconds: 9.5,
      grid: spriteGrid(5),
      tileWidth: 160,
      tileHeight: 90,
    });
    const lines = track.split('\n');
    expect(lines[0]).toBe('WEBVTT');
    expect(track).toContain('00:00:00.000 --> 00:00:02.000\nsprite_000.jpg#xywh=0,0,160,90');
    expect(track).toContain('00:00:06.000 --> 00:00:08.000\nsprite_000.jpg#xywh=480,0,160,90');
    // The final cue is clamped to the video duration.
    expect(track).toContain('00:00:08.000 --> 00:00:09.500\nsprite_000.jpg#xywh=640,0,160,90');
    expect(parseWebVtt(track).cueCount).toBe(5);
  });

  it('wraps rows and rolls over to the next sheet', () => {
    const grid = spriteGrid(105);
    const track = buildThumbnailTrack({
      count: 105,
      intervalSeconds: 1,
      durationSeconds: 105,
      grid,
      tileWidth: 160,
      tileHeight: 90,
    });
    expect(track).toContain('sprite_000.jpg#xywh=0,90,160,90'); // tile 10: row 1, col 0
    expect(track).toContain('sprite_000.jpg#xywh=1440,810,160,90'); // tile 99: last cell
    expect(track).toContain('sprite_001.jpg#xywh=0,0,160,90'); // tile 100: next sheet
    expect(spriteFileName(12)).toBe('sprite_012.jpg');
    expect(parseWebVtt(track).cueCount).toBe(105);
  });
});

describe('watermark', () => {
  it('places the overlay in each corner with a margin', () => {
    const m = WATERMARK_MARGIN_RATIO;
    expect(overlayPosition('top-left')).toBe(`main_w*${m}:main_h*${m}`);
    expect(overlayPosition('top-right')).toBe(`main_w-overlay_w-main_w*${m}:main_h*${m}`);
    expect(overlayPosition('bottom-left')).toBe(`main_w*${m}:main_h-overlay_h-main_h*${m}`);
    expect(overlayPosition('bottom-right')).toBe(
      `main_w-overlay_w-main_w*${m}:main_h-overlay_h-main_h*${m}`,
    );
  });

  it('builds a chain that applies opacity to the logo and overlays the source', () => {
    const { chain, outputLabel } = buildWatermarkChain({
      imagePath: '/logo.png',
      position: 'top-left',
      opacity: 0.6,
    });
    expect(outputLabel).toBe('[wmbase]');
    expect(chain).toBe(
      '[1:v]format=rgba,colorchannelmixer=aa=0.6[wmlogo];' +
        `[0:v][wmlogo]overlay=${overlayPosition('top-left')}[wmbase]`,
    );
  });

  it('clamps opacity into 0-1', () => {
    const high = buildWatermarkChain({ imagePath: '/l.png', position: 'top-left', opacity: 5 });
    const low = buildWatermarkChain({ imagePath: '/l.png', position: 'top-left', opacity: -1 });
    expect(high.chain).toContain('aa=1');
    expect(low.chain).toContain('aa=0');
  });
});
