import type { MediaInfo } from './probe.js';
import { GOP_SECONDS, SEGMENT_SECONDS, type RenditionProfile } from './profiles.js';

export const PLAYLIST_FILE = 'index.m3u8';
export const INIT_FILE = 'init.mp4';
export const SEGMENT_PATTERN = 'seg_%03d.m4s';

export interface RenditionPlan {
  profile: RenditionProfile;
  /** Output frame size: never upscaled, even dimensions, orientation preserved. */
  width: number;
  height: number;
  frameRate: number;
  includeAudio: boolean;
}

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

/**
 * Decide the output frame size for a profile against a real source. The profile's `height` is
 * the target for the frame's shorter side; the longer side follows the source aspect ratio.
 */
export function planRendition(profile: RenditionProfile, info: MediaInfo): RenditionPlan {
  if (!info.hasVideo || info.width === null || info.height === null) {
    throw new Error('cannot plan a rendition for a source without a video stream');
  }
  const portrait = info.height > info.width;
  const shortSide = Math.min(info.width, info.height);
  const targetShort = Math.min(profile.height, shortSide);
  const scale = targetShort / shortSide;
  const width = even(info.width * scale);
  const height = even(info.height * scale);
  return {
    profile,
    width: portrait ? Math.min(width, even(targetShort)) : width,
    height: portrait ? height : Math.min(height, even(targetShort)),
    frameRate: info.frameRate ?? 30,
    includeAudio: info.hasAudio,
  };
}

export interface RenditionArgsOptions {
  /** libx264 preset. */
  preset: string;
}

/**
 * FFmpeg arguments for one H.264/AAC rendition packaged as CMAF: fragmented-MP4 segments plus
 * an HLS media playlist, written to the current working directory (run with `cwd` = output dir
 * so the playlist references segments by bare filename).
 *
 * Keyframes are forced on a fixed clock (`GOP_SECONDS`) with scene-cut detection off, so every
 * rung of the ladder (Milestone 6) cuts segments at identical timestamps.
 */
export function buildRenditionArgs(
  sourcePath: string,
  plan: RenditionPlan,
  options: RenditionArgsOptions,
): string[] {
  const { profile } = plan;
  if (profile.codec !== 'h264') {
    throw new Error(`codec ${profile.codec} is not supported yet (AV1 arrives in Milestone 8)`);
  }
  const gopFrames = Math.max(1, Math.round(GOP_SECONDS * plan.frameRate));

  const args = ['-y', '-i', sourcePath, '-map', '0:v:0'];
  if (plan.includeAudio) args.push('-map', '0:a:0');

  args.push(
    '-vf',
    `scale=${plan.width}:${plan.height},format=yuv420p`,
    '-c:v',
    'libx264',
    '-preset',
    options.preset,
    '-profile:v',
    'high',
    '-level',
    '4.1',
    '-b:v',
    `${profile.videoBitrateKbps}k`,
    '-maxrate',
    `${profile.maxrateKbps}k`,
    '-bufsize',
    `${profile.bufsizeKbps}k`,
    '-g',
    String(gopFrames),
    '-keyint_min',
    String(gopFrames),
    '-sc_threshold',
    '0',
    '-force_key_frames',
    `expr:gte(t,n_forced*${GOP_SECONDS})`,
  );

  if (plan.includeAudio) {
    args.push(
      '-c:a',
      'aac',
      '-b:a',
      `${profile.audioBitrateKbps}k`,
      '-ar',
      String(profile.audioSampleRate),
      '-ac',
      String(profile.audioChannels),
    );
  }

  args.push(
    '-f',
    'hls',
    '-hls_time',
    String(SEGMENT_SECONDS),
    '-hls_playlist_type',
    'vod',
    '-hls_segment_type',
    'fmp4',
    '-hls_flags',
    'independent_segments',
    '-hls_fmp4_init_filename',
    INIT_FILE,
    '-hls_segment_filename',
    SEGMENT_PATTERN,
    PLAYLIST_FILE,
  );
  return args;
}
