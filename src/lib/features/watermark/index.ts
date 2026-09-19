import type { WATERMARK_POSITIONS } from '../../../config/index.js';

export type WatermarkPosition = (typeof WATERMARK_POSITIONS)[number];

export interface WatermarkConfig {
  /** Path to the overlay image on the worker's filesystem (PNG with alpha recommended). */
  imagePath: string;
  position: WatermarkPosition;
  /** 0-1. Multiplied into the image's own alpha, so transparent PNGs stay transparent. */
  opacity: number;
}

/** Inset from the frame edge, as a fraction of the frame size. */
export const WATERMARK_MARGIN_RATIO = 0.02;

/**
 * `overlay` x:y expression for a corner. Uses `main_*`/`overlay_*` so it is independent of the
 * source resolution, and insets by a fixed fraction of the frame.
 */
export function overlayPosition(position: WatermarkPosition): string {
  const m = WATERMARK_MARGIN_RATIO;
  const left = `main_w*${m}`;
  const right = `main_w-overlay_w-main_w*${m}`;
  const top = `main_h*${m}`;
  const bottom = `main_h-overlay_h-main_h*${m}`;
  switch (position) {
    case 'top-left':
      return `${left}:${top}`;
    case 'top-right':
      return `${right}:${top}`;
    case 'bottom-left':
      return `${left}:${bottom}`;
    case 'bottom-right':
      return `${right}:${bottom}`;
  }
}

export interface WatermarkChain {
  /** Filter-graph label carrying the watermarked source, e.g. `[wmbase]`. */
  outputLabel: string;
  /** Filter chain to prepend to the ladder graph. */
  chain: string;
}

/**
 * Build the overlay chain. It runs once on the decoded source, before the ladder split, so the
 * watermark is composited a single time and then scales with each rung (a logo covering 10% of
 * a 1080p frame covers 10% of the 360p frame too).
 *
 * The image is used at its native size; scale it for your top rung.
 */
export function buildWatermarkChain(config: WatermarkConfig, inputIndex = 1): WatermarkChain {
  const opacity = Math.max(0, Math.min(1, config.opacity));
  return {
    outputLabel: '[wmbase]',
    chain:
      `[${inputIndex}:v]format=rgba,colorchannelmixer=aa=${opacity}[wmlogo];` +
      `[0:v][wmlogo]overlay=${overlayPosition(config.position)}[wmbase]`,
  };
}
