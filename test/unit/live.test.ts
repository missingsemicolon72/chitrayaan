import { describe, expect, it } from 'vitest';

import {
  buildLiveHlsArgs,
  isLiveFileName,
  liveKey,
  parseLivePlaylist,
  withEndList,
} from '../../src/lib/packaging/index.js';
import { RealtimeMonitor, REALTIME_WINDOW_MS } from '../../src/lib/rtmp/index.js';

/** A playlist as FFmpeg 8 writes it mid-stream (trimmed from a real run). */
const LIVE_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:2
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MAP:URI="init.mp4"
#EXTINF:2.000000,
#EXT-X-PROGRAM-DATE-TIME:2026-10-13T20:05:46.281+0530
seg_00002.m4s
#EXTINF:2.000000,
#EXT-X-PROGRAM-DATE-TIME:2026-10-13T20:05:48.281+0530
seg_00003.m4s
`;

/** The value following `flag` in an argument list. */
function after(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

describe('live HLS output arguments', () => {
  const args = buildLiveHlsArgs();

  it('encodes the 720p H.264/AAC rung with a keyframe at every segment boundary', () => {
    expect(after(args, '-c:v')).toBe('libx264');
    expect(after(args, '-profile:v')).toBe('high');
    expect(after(args, '-b:v')).toBe('2800k');
    expect(after(args, '-c:a')).toBe('aac');
    expect(after(args, '-b:a')).toBe('128k');
    expect(after(args, '-ar')).toBe('48000');
    expect(after(args, '-ac')).toBe('2');
    expect(after(args, '-force_key_frames')).toBe('expr:gte(t,n_forced*2)');
    expect(after(args, '-sc_threshold')).toBe('0');
    // Either stream may be absent from the publisher.
    expect(args.filter((a) => a === '-map')).toHaveLength(2);
    expect(args).toContain('0:v:0?');
    expect(args).toContain('0:a:0?');
  });

  it('scales the shorter side down to 720 and never up, keeping orientation', () => {
    expect(after(args, '-vf')).toBe(
      "scale=w='if(gte(iw,ih),-2,trunc(min(720,iw)/2)*2)':h='if(gte(iw,ih),trunc(min(720,ih)/2)*2,-2)',format=yuv420p",
    );
  });

  it('writes a sliding-window fMP4 playlist with relative names', () => {
    expect(after(args, '-f')).toBe('hls');
    expect(after(args, '-hls_time')).toBe('2');
    expect(after(args, '-hls_list_size')).toBe('6');
    expect(after(args, '-hls_segment_type')).toBe('fmp4');
    expect(after(args, '-hls_fmp4_init_filename')).toBe('init.mp4');
    expect(after(args, '-hls_segment_filename')).toBe('seg_%05d.m4s');
    expect(after(args, '-hls_flags')?.split('+')).toEqual(
      expect.arrayContaining(['delete_segments', 'temp_file', 'program_date_time']),
    );
    expect(args.at(-1)).toBe('live.m3u8');
  });
});

describe('live playlists', () => {
  it('reads the init segment, the media segments and whether the stream ended', () => {
    expect(parseLivePlaylist(LIVE_PLAYLIST)).toEqual({
      initSegment: 'init.mp4',
      segments: ['seg_00002.m4s', 'seg_00003.m4s'],
      ended: false,
    });
    expect(parseLivePlaylist(`${LIVE_PLAYLIST}#EXT-X-ENDLIST\n`).ended).toBe(true);
    expect(parseLivePlaylist(LIVE_PLAYLIST.replaceAll('\n', '\r\n')).segments).toHaveLength(2);
  });

  it('marks a playlist as ended exactly once', () => {
    const ended = withEndList(LIVE_PLAYLIST);
    expect(ended.endsWith('seg_00003.m4s\n#EXT-X-ENDLIST\n')).toBe(true);
    expect(withEndList(ended)).toBe(ended);
  });

  it('accepts only the names a live session publishes', () => {
    for (const name of ['live.m3u8', 'init.mp4', 'seg_00000.m4s', 'seg_123456.m4s']) {
      expect(isLiveFileName(name), name).toBe(true);
    }
    for (const name of [
      '../live.m3u8',
      'live.m3u8.tmp',
      'seg_00000.m4s.tmp',
      'seg_1.m4s',
      'master.m3u8',
      'init.mp4/x',
      '',
    ]) {
      expect(isLiveFileName(name), name).toBe(false);
    }
    expect(liveKey('abc', 'live.m3u8')).toBe('live/abc/live.m3u8');
  });
});

describe('RealtimeMonitor', () => {
  /** Feed samples every 500 ms in which media advances `rate` seconds per second. */
  function feed(
    monitor: RealtimeMonitor,
    fromMs: number,
    toMs: number,
    startMedia: number,
    rate: number,
  ) {
    let ratio: number | null = null;
    for (let t = fromMs; t <= toMs; t += 500) {
      ratio = monitor.add(t, startMedia + ((t - fromMs) / 1000) * rate);
    }
    return ratio;
  }

  it('reports nothing until a whole window has passed', () => {
    const monitor = new RealtimeMonitor();
    expect(feed(monitor, 0, REALTIME_WINDOW_MS - 500, 0, 1)).toBeNull();
    expect(monitor.add(REALTIME_WINDOW_MS, 10)).toBeCloseTo(1);
  });

  it('measures media time against the clock over the latest window only', () => {
    const monitor = new RealtimeMonitor();
    expect(feed(monitor, 0, 20_000, 0, 1)).toBeCloseTo(1);
    // A slowdown shows within one window, however long the stream kept up before it.
    expect(feed(monitor, 20_500, 30_000, 20.5, 0.5)).toBeCloseTo(0.5, 1);
  });
});
