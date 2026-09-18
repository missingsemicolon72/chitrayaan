import type { Codec } from '../db/index.js';

/** CMAF segment length. Players buffer in whole segments, so shorter = faster start, more files. */
export const SEGMENT_SECONDS = 4;
/** Keyframe interval. Must divide the segment length so every segment starts on an IDR frame. */
export const GOP_SECONDS = 2;

export interface RenditionProfile {
  /** Directory name under `videos/<id>/` and the `renditions.name` value. */
  name: string;
  codec: Codec;
  /** Target size of the frame's shorter side (so a portrait source keeps its orientation). */
  height: number;
  videoBitrateKbps: number;
  maxrateKbps: number;
  bufsizeKbps: number;
  audioBitrateKbps: number;
  audioSampleRate: number;
  audioChannels: number;
}

const AUDIO = { audioBitrateKbps: 128, audioSampleRate: 48_000, audioChannels: 2 } as const;

function h264(height: number, videoBitrateKbps: number): RenditionProfile {
  return {
    name: `h264_${height}p`,
    codec: 'h264',
    height,
    videoBitrateKbps,
    // Standard VBV settings for ABR: allow ~7% peaks, buffer two seconds' worth of bits.
    maxrateKbps: Math.round(videoBitrateKbps * 1.07),
    bufsizeKbps: videoBitrateKbps * 2,
    ...AUDIO,
  };
}

/** The H.264/AAC ladder from CLAUDE.md (`[default, adjustable]`). Milestone 6 uses all rungs. */
export const H264_LADDER: readonly RenditionProfile[] = [
  h264(360, 800),
  h264(480, 1400),
  h264(720, 2800),
  h264(1080, 5000),
];

/** Milestone 5's single rendition. */
export const H264_720P = H264_LADDER[2]!;

function av1(height: number, videoBitrateKbps: number): RenditionProfile {
  return {
    name: `av1_${height}p`,
    codec: 'av1',
    height,
    videoBitrateKbps,
    maxrateKbps: Math.round(videoBitrateKbps * 1.07),
    bufsizeKbps: videoBitrateKbps * 2,
    ...AUDIO,
  };
}

/**
 * The same rungs as AV1 (decision #10: opt-in via CODEC_LADDER). Bitrates are ~65% of the
 * H.264 rung, the usual allowance for AV1's better compression `[default, adjustable]`.
 */
export const AV1_LADDER: readonly RenditionProfile[] = [
  av1(360, 500),
  av1(480, 900),
  av1(720, 1800),
  av1(1080, 3200),
];

export const LADDERS: Readonly<Record<Codec, readonly RenditionProfile[]>> = {
  h264: H264_LADDER,
  av1: AV1_LADDER,
};

export function profileByName(name: string): RenditionProfile | undefined {
  return [...H264_LADDER, ...AV1_LADDER].find((p) => p.name === name);
}
