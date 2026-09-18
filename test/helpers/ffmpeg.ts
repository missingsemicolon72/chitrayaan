import { stat } from 'node:fs/promises';

import { binaryVersion } from '../../src/lib/transcode/index.js';
import { fixturePath } from '../fixtures/generate.js';

export const FFMPEG_PATH = process.env.FFMPEG_PATH ?? 'ffmpeg';
export const FFPROBE_PATH = process.env.FFPROBE_PATH ?? 'ffprobe';

let probe: Promise<boolean> | undefined;

/** True when ffmpeg and ffprobe run and the synthetic fixtures were generated. */
export function ffmpegAvailable(): Promise<boolean> {
  probe ??= (async () => {
    try {
      await Promise.all([binaryVersion(FFMPEG_PATH), binaryVersion(FFPROBE_PATH)]);
      await stat(fixturePath('1080p-10s.mp4'));
      return true;
    } catch {
      console.warn('[tests] ffmpeg/ffprobe or fixtures unavailable; transcode tests are skipped');
      return false;
    }
  })();
  return probe;
}

export { fixturePath };
