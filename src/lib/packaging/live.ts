import { H264_720P } from '../transcode/profiles.js';

/**
 * Live HLS output (phase 2): the RTMP listener's FFmpeg encodes one H.264/AAC rung in real time
 * and packages it as CMAF (fragmented MP4, decision #9) under a sliding-window playlist. FFmpeg
 * runs with its working directory set to the session's work dir, so every name here is relative
 * to that directory; the live process then copies the files to storage under `live/<id>/`.
 */
export const LIVE_PLAYLIST = 'live.m3u8';
export const LIVE_INIT_SEGMENT = 'init.mp4';
/** printf pattern FFmpeg numbers media segments with. */
const LIVE_SEGMENT_PATTERN = 'seg_%05d.m4s';
/** Every file a live session publishes. Five digits grow to six after ~55 hours, hence `{5,}`. */
const LIVE_FILE = /^(?:live\.m3u8|init\.mp4|seg_\d{5,}\.m4s)$/;

/** Segment length. Shorter than VOD's: a live player sits about three segments behind the edge. */
export const LIVE_SEGMENT_SECONDS = 2;
/** Segments the playlist lists at once, i.e. how far behind the live edge a player can be. */
export const LIVE_WINDOW_SEGMENTS = 6;
/**
 * Segments a playlist must list before players see it. A player starts three segments behind
 * the newest (the HLS spec's minimum distance from the end), so a shorter playlist makes it
 * start at the very edge and stall every time it catches up.
 */
export const LIVE_START_SEGMENTS = 3;
/** The single live rung (decision #2): the 720p H.264/AAC rung of the VOD ladder. */
export const LIVE_RUNG = H264_720P;
/** Fast enough to stay real-time next to VOD transcodes; quality is the rung's bitrate's job. */
export const LIVE_X264_PRESET = 'veryfast';

/** Storage prefix of live sessions: `live/<session id>/<file>`. */
export const LIVE_PREFIX = 'live';
/** Directory under the work root where the live process stages FFmpeg's output. */
export const LIVE_WORK_DIR_NAME = 'chitrayaan-live';

export function liveKey(sessionId: string, file: string): string {
  return `${LIVE_PREFIX}/${sessionId}/${file}`;
}

/** True for a name a live session can publish (and so the API may serve). */
export function isLiveFileName(name: string): boolean {
  return LIVE_FILE.test(name);
}

/**
 * Scale so the shorter side is at most `height`: never upscaled, orientation kept, both sides
 * even. The input size is unknown when FFmpeg starts listening, so this is an expression
 * rather than the fixed size VOD computes from a probe.
 */
function scaleFilter(height: number): string {
  const shorter = (side: 'iw' | 'ih') => `trunc(min(${height},${side})/2)*2`;
  return (
    `scale=w='if(gte(iw,ih),-2,${shorter('iw')})':h='if(gte(iw,ih),${shorter('ih')},-2)',` +
    'format=yuv420p'
  );
}

/** Output arguments for the live listener's FFmpeg. Run it with `cwd` = the session work dir. */
export function buildLiveHlsArgs(): string[] {
  const rung = LIVE_RUNG;
  const kbps = (n: number) => `${n}k`;
  return [
    // The first video and audio streams; either may be missing (`?`).
    '-map',
    '0:v:0?',
    '-map',
    '0:a:0?',
    '-vf',
    scaleFilter(rung.height),
    '-c:v',
    'libx264',
    '-preset',
    LIVE_X264_PRESET,
    '-profile:v',
    'high',
    '-b:v',
    kbps(rung.videoBitrateKbps),
    '-maxrate',
    kbps(rung.maxrateKbps),
    '-bufsize',
    kbps(rung.bufsizeKbps),
    // Every segment must start on a keyframe: force one per segment and none in between. The
    // input frame rate is unknown up front, so this is by time rather than a frame count.
    '-force_key_frames',
    `expr:gte(t,n_forced*${LIVE_SEGMENT_SECONDS})`,
    '-sc_threshold',
    '0',
    '-c:a',
    'aac',
    '-b:a',
    kbps(rung.audioBitrateKbps),
    '-ar',
    String(rung.audioSampleRate),
    '-ac',
    String(rung.audioChannels),
    '-f',
    'hls',
    '-hls_time',
    String(LIVE_SEGMENT_SECONDS),
    '-hls_list_size',
    String(LIVE_WINDOW_SEGMENTS),
    '-hls_segment_type',
    'fmp4',
    '-hls_fmp4_init_filename',
    LIVE_INIT_SEGMENT,
    '-hls_segment_filename',
    LIVE_SEGMENT_PATTERN,
    // delete_segments keeps the work dir to the window; temp_file makes segments and the
    // playlist appear whole (written aside, then renamed); program_date_time stamps each
    // segment with wall-clock time, which players use to measure latency.
    '-hls_flags',
    'delete_segments+independent_segments+temp_file+program_date_time',
    LIVE_PLAYLIST,
  ];
}

export interface LivePlaylist {
  /** The `#EXT-X-MAP` init segment, or null before FFmpeg has written one. */
  initSegment: string | null;
  /** Media segment URIs, oldest first. */
  segments: string[];
  /** `#EXT-X-ENDLIST` is present: the stream is over. */
  ended: boolean;
}

/** Read the parts of a live media playlist the live process acts on. */
export function parseLivePlaylist(text: string): LivePlaylist {
  let initSegment: string | null = null;
  const segments: string[] = [];
  let ended = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith('#EXT-X-MAP:')) {
      initSegment = /URI="([^"]+)"/.exec(line)?.[1] ?? null;
    } else if (line === '#EXT-X-ENDLIST') {
      ended = true;
    } else if (!line.startsWith('#')) {
      segments.push(line);
    }
  }
  return { initSegment, segments, ended };
}

/**
 * The playlist with `#EXT-X-ENDLIST` appended if it lacks one. FFmpeg writes it when it shuts
 * down cleanly; after a crash or a forced kill it does not, and players would wait forever.
 */
export function withEndList(text: string): string {
  return parseLivePlaylist(text).ended ? text : `${text.trimEnd()}\n#EXT-X-ENDLIST\n`;
}
