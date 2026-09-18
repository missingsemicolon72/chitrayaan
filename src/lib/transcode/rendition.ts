import type { MediaInfo } from './probe.js';
import type { RenditionProfile } from './profiles.js';

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

/**
 * Plan every rung of a ladder for a source, ascending. Rungs above the source's resolution are
 * capped at the source size, and a rung whose capped size duplicates a lower one is dropped, so
 * a 480p source yields 360p + 480p rather than four copies of 480p. Always returns at least one.
 */
export function planLadder(
  profiles: readonly RenditionProfile[],
  info: MediaInfo,
): RenditionPlan[] {
  const plans: RenditionPlan[] = [];
  for (const profile of [...profiles].sort((a, b) => a.height - b.height)) {
    const plan = planRendition(profile, info);
    if (plans.some((p) => p.width === plan.width && p.height === plan.height)) continue;
    plans.push(plan);
  }
  return plans;
}
