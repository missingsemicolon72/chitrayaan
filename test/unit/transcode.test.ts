import { describe, expect, it } from 'vitest';

import {
  AV1_LADDER,
  GOP_SECONDS,
  H264_720P,
  H264_LADDER,
  interpretProbeOutput,
  LADDERS,
  looksLikeCorruptInput,
  parseProgressBlock,
  planLadder,
  planRendition,
  ProbeError,
  profileByName,
  SEGMENT_SECONDS,
  TailBuffer,
  type MediaInfo,
} from '../../src/lib/transcode/index.js';

const source = (over: Partial<MediaInfo>): MediaInfo => ({
  formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
  durationSeconds: 10,
  width: 1920,
  height: 1080,
  frameRate: 30,
  videoCodec: 'h264',
  audioCodec: 'aac',
  hasVideo: true,
  hasAudio: true,
  bitrateKbps: 4000,
  ...over,
});

describe('ladder profiles', () => {
  it('matches the CLAUDE.md defaults, ascending', () => {
    expect(H264_LADDER.map((p) => [p.name, p.height, p.videoBitrateKbps])).toEqual([
      ['h264_360p', 360, 800],
      ['h264_480p', 480, 1400],
      ['h264_720p', 720, 2800],
      ['h264_1080p', 1080, 5000],
    ]);
    expect(H264_720P.name).toBe('h264_720p');
    expect(SEGMENT_SECONDS % GOP_SECONDS).toBe(0);
  });

  it('offers the same rungs as AV1 at lower bitrates, and never HEVC', () => {
    expect(AV1_LADDER.map((p) => [p.name, p.height, p.codec])).toEqual([
      ['av1_360p', 360, 'av1'],
      ['av1_480p', 480, 'av1'],
      ['av1_720p', 720, 'av1'],
      ['av1_1080p', 1080, 'av1'],
    ]);
    AV1_LADDER.forEach((av1, i) => {
      const h264 = H264_LADDER[i]!;
      expect(av1.videoBitrateKbps).toBeLessThan(h264.videoBitrateKbps);
      expect(av1.videoBitrateKbps).toBeGreaterThan(h264.videoBitrateKbps * 0.5);
    });
    expect(Object.keys(LADDERS).sort()).toEqual(['av1', 'h264']);
    expect(profileByName('av1_720p')?.codec).toBe('av1');
    expect(profileByName('hevc_720p')).toBeUndefined();
  });
});

describe('planRendition', () => {
  it('downscales a 1080p landscape source to 1280x720', () => {
    const plan = planRendition(H264_720P, source({}));
    expect([plan.width, plan.height]).toEqual([1280, 720]);
    expect(plan.frameRate).toBe(30);
    expect(plan.includeAudio).toBe(true);
  });

  it('never upscales: a 480p source stays 854x480', () => {
    const plan = planRendition(H264_720P, source({ width: 854, height: 480 }));
    expect([plan.width, plan.height]).toEqual([854, 480]);
  });

  it('treats the rung height as the short side for portrait sources', () => {
    const plan = planRendition(H264_720P, source({ width: 1080, height: 1920 }));
    expect([plan.width, plan.height]).toEqual([720, 1280]);
  });

  it('keeps dimensions even and defaults the frame rate', () => {
    const plan = planRendition(H264_720P, source({ width: 1919, height: 1079, frameRate: null }));
    expect(plan.width % 2).toBe(0);
    expect(plan.height % 2).toBe(0);
    expect(plan.height).toBe(720);
    expect(plan.frameRate).toBe(30);
  });

  it('refuses a source without video', () => {
    expect(() =>
      planRendition(H264_720P, source({ hasVideo: false, width: null, height: null })),
    ).toThrow(/without a video stream/);
  });
});

describe('planLadder', () => {
  const sizes = (info: MediaInfo) =>
    planLadder(H264_LADDER, info).map((p) => `${p.profile.name}:${p.width}x${p.height}`);

  it('uses every rung for a 1080p source', () => {
    expect(sizes(source({}))).toEqual([
      'h264_360p:640x360',
      'h264_480p:854x480',
      'h264_720p:1280x720',
      'h264_1080p:1920x1080',
    ]);
  });

  it('drops rungs that would only duplicate the source resolution', () => {
    expect(sizes(source({ width: 854, height: 480 }))).toEqual([
      'h264_360p:640x360',
      'h264_480p:854x480',
    ]);
    expect(sizes(source({ width: 320, height: 240 }))).toEqual(['h264_360p:320x240']);
  });

  it('caps the top rung at an in-between source size', () => {
    expect(sizes(source({ width: 1600, height: 900 }))).toEqual([
      'h264_360p:640x360',
      'h264_480p:854x480',
      'h264_720p:1280x720',
      'h264_1080p:1600x900',
    ]);
  });

  it('keeps portrait orientation on every rung', () => {
    expect(sizes(source({ width: 1080, height: 1920 }))).toEqual([
      'h264_360p:360x640',
      'h264_480p:480x854',
      'h264_720p:720x1280',
      'h264_1080p:1080x1920',
    ]);
  });
});

describe('parseProgressBlock', () => {
  it('reads microsecond timestamps and computes a percentage', () => {
    const p = parseProgressBlock({ out_time_us: '4500000', fps: '61.2', speed: '2.04x' }, 10);
    expect(p.outTimeSeconds).toBe(4.5);
    expect(p.percent).toBe(45);
    expect(p.fps).toBe(61.2);
    expect(p.speed).toBe('2.04x');
  });

  it('falls back to out_time_ms and hh:mm:ss, clamps to 100, and handles unknown duration', () => {
    expect(parseProgressBlock({ out_time_ms: '12000000' }, 10).percent).toBe(100);
    expect(parseProgressBlock({ out_time: '00:00:02.500000' }, 10).outTimeSeconds).toBe(2.5);
    expect(parseProgressBlock({ out_time_us: 'N/A' }, 10).outTimeSeconds).toBe(0);
    expect(parseProgressBlock({ out_time_us: '1000000' }, undefined).percent).toBeNull();
  });
});

describe('looksLikeCorruptInput', () => {
  it('recognises the ways FFmpeg reports unusable input', () => {
    for (const line of [
      '[in#0] Error opening input: Invalid data found when processing input',
      '[mov,mp4 @ 0x1] moov atom not found',
      '[h264 @ 0x1] Invalid NAL unit size (94017 > 54606).',
      'Could not find codec parameters for stream 0',
      'Output file is empty, nothing was encoded',
      'partial file',
    ]) {
      expect(looksLikeCorruptInput(line), line).toBe(true);
    }
  });

  it('does not claim ordinary failures are bad input', () => {
    for (const line of [
      'No space left on device',
      'Cannot allocate memory',
      'Conversion failed!',
      'Error while filtering: Operation not permitted',
      '',
    ]) {
      expect(looksLikeCorruptInput(line), line).toBe(false);
    }
  });
});

describe('TailBuffer', () => {
  it('keeps only the last N non-empty lines across chunk boundaries', () => {
    const tail = new TailBuffer(3);
    tail.push('one\ntwo\nth');
    tail.push('ree\n\nfour\nfi');
    expect(tail.toString()).toBe('three\nfour\nfi');
  });
});

describe('interpretProbeOutput', () => {
  const stream = (over: Record<string, unknown>) => ({
    codec_type: 'video',
    codec_name: 'h264',
    ...over,
  });

  it('extracts dimensions, duration, frame rate and codecs', () => {
    const info = interpretProbeOutput({
      format: { format_name: 'mov,mp4', duration: '10.010000', bit_rate: '3999000' },
      streams: [
        stream({ width: 1920, height: 1080, avg_frame_rate: '30000/1001' }),
        { codec_type: 'audio', codec_name: 'aac' },
      ],
    });
    expect(info).toMatchObject({
      durationSeconds: 10.01,
      width: 1920,
      height: 1080,
      videoCodec: 'h264',
      audioCodec: 'aac',
      hasVideo: true,
      hasAudio: true,
      bitrateKbps: 3999,
    });
    expect(info.frameRate).toBeCloseTo(29.97, 2);
  });

  it('applies 90/270 degree rotation metadata to the display size', () => {
    const info = interpretProbeOutput({
      format: { duration: '5' },
      streams: [stream({ width: 1920, height: 1080, side_data_list: [{ rotation: -90 }] })],
    });
    expect([info.width, info.height]).toEqual([1080, 1920]);
  });

  it('ignores cover-art streams and reports audio-only files', () => {
    const info = interpretProbeOutput({
      format: { duration: '3' },
      streams: [
        stream({ codec_name: 'mjpeg', width: 300, height: 300, disposition: { attached_pic: 1 } }),
        { codec_type: 'audio', codec_name: 'mp3' },
      ],
    });
    expect(info.hasVideo).toBe(false);
    expect(info.width).toBeNull();
    expect(info.hasAudio).toBe(true);
  });

  it('rejects output without a usable duration', () => {
    expect(() => interpretProbeOutput({ format: {}, streams: [stream({})] })).toThrow(ProbeError);
    expect(() => interpretProbeOutput({ format: { duration: '0' }, streams: [] })).toThrow(
      /duration/,
    );
    expect(() => interpretProbeOutput('nonsense')).toThrow(ProbeError);
  });
});
