import { describe, expect, it } from 'vitest';

import {
  buildRenditionArgs,
  GOP_SECONDS,
  H264_720P,
  H264_LADDER,
  interpretProbeOutput,
  parseProgressBlock,
  planRendition,
  ProbeError,
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

describe('buildRenditionArgs', () => {
  it('encodes H.264/AAC into CMAF fMP4 segments with a fixed GOP', () => {
    const plan = planRendition(H264_720P, source({}));
    const args = buildRenditionArgs('/in/source.mp4', plan, { preset: 'veryfast' });
    const joined = args.join(' ');

    expect(args.slice(0, 3)).toEqual(['-y', '-i', '/in/source.mp4']);
    expect(joined).toContain('-map 0:v:0 -map 0:a:0');
    expect(joined).toContain('-vf scale=1280:720,format=yuv420p');
    expect(joined).toContain('-c:v libx264 -preset veryfast -profile:v high');
    expect(joined).toContain('-b:v 2800k -maxrate 2996k -bufsize 5600k');
    expect(joined).toContain(`-g ${2 * 30} -keyint_min ${2 * 30} -sc_threshold 0`);
    expect(joined).toContain(`-force_key_frames expr:gte(t,n_forced*${GOP_SECONDS})`);
    expect(joined).toContain('-c:a aac -b:a 128k -ar 48000 -ac 2');
    expect(joined).toContain(
      `-f hls -hls_time ${SEGMENT_SECONDS} -hls_playlist_type vod -hls_segment_type fmp4`,
    );
    expect(joined).toContain(
      '-hls_fmp4_init_filename init.mp4 -hls_segment_filename seg_%03d.m4s index.m3u8',
    );
  });

  it('omits audio mapping and encoding for silent sources', () => {
    const plan = planRendition(H264_720P, source({ hasAudio: false, audioCodec: null }));
    const joined = buildRenditionArgs('/in/s.mp4', plan, { preset: 'medium' }).join(' ');
    expect(joined).not.toContain('0:a:0');
    expect(joined).not.toContain('-c:a');
  });

  it('rejects codecs that are not implemented yet', () => {
    const plan = planRendition({ ...H264_720P, codec: 'av1', name: 'av1_720p' }, source({}));
    expect(() => buildRenditionArgs('/in/s.mp4', plan, { preset: 'medium' })).toThrow(
      /Milestone 8/,
    );
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
