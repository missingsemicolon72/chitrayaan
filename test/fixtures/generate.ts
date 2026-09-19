/**
 * Synthetic test clips, generated with FFmpeg's `testsrc2` / `sine` sources (CLAUDE.md testing
 * strategy: fast, free, no copyright issues). Files land in `test/fixtures/generated/`, which
 * is gitignored, and are only regenerated when missing.
 *
 * Used as Vitest `globalSetup` (runs once before the workers start) and via `npm run fixtures`.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'generated');

const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';

interface Clip {
  size: string;
  fps: number;
  seconds: number;
  audio: boolean;
}

/** Encoded clips: name -> recipe. Keep them short (CLAUDE.md: 5-15s for the inner loop). */
export const CLIPS: Record<string, Clip> = {
  '1080p-10s.mp4': { size: '1920x1080', fps: 30, seconds: 10, audio: true },
  '480p-5s.mp4': { size: '854x480', fps: 25, seconds: 5, audio: true },
  'silent-720p-5s.mp4': { size: '1280x720', fps: 30, seconds: 5, audio: false },
  'portrait-1080x1920-5s.mp4': { size: '1080x1920', fps: 30, seconds: 5, audio: true },
};

/**
 * Media that is technically valid but unusable as a video source. Unlike `BROKEN` these are
 * produced by FFmpeg, so they exercise the "probe succeeds, content is wrong" path.
 */
export const DEGENERATE: Record<string, (out: string) => string[]> = {
  // A container with no frames at all: nothing to transcode, no duration to report.
  'zero-frames.mp4': (out) => [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x240:rate=30',
    '-frames:v',
    '0',
    out,
  ],
  // Sound with no video stream.
  'audio-only.m4a': (out) => [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000',
    '-t',
    '3',
    '-c:a',
    'aac',
    out,
  ],
};

/** Deliberately broken inputs, derived from the clips above or written directly. */
export const BROKEN = {
  /** First 64 KiB of a valid MP4: header present, media data cut off. */
  'truncated.mp4': async () =>
    (await readFile(path.join(FIXTURES_DIR, '1080p-10s.mp4'))).subarray(0, 64 * 1024),
  /** Text with a video extension. */
  'not-a-video.mp4': () => Promise.resolve(Buffer.from('this is not a video file\n'.repeat(100))),
  /** Zero bytes. */
  'empty.mp4': () => Promise.resolve(Buffer.alloc(0)),
};

function clipArgs(clip: Clip, out: string): string[] {
  const args = ['-y', '-f', 'lavfi', '-i', `testsrc2=size=${clip.size}:rate=${clip.fps}`];
  if (clip.audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000');
  args.push(
    '-t',
    String(clip.seconds),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
  );
  if (clip.audio) args.push('-c:a', 'aac', '-b:a', '96k');
  args.push('-movflags', '+faststart', out);
  return args;
}

function run(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => {
      stderr += c;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `ffmpeg exited with ${String(code)}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`,
          ),
        );
    });
  });
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).size >= 0;
  } catch {
    return false;
  }
}

export function fixturePath(name: string): string {
  return path.join(FIXTURES_DIR, name);
}

/** Generate every missing fixture. Returns false (and warns) when FFmpeg is unavailable. */
export async function generateFixtures(): Promise<boolean> {
  await mkdir(FIXTURES_DIR, { recursive: true });
  try {
    await run(['-version']);
  } catch {
    console.warn(
      `[fixtures] ${FFMPEG} not runnable; media fixtures not generated, transcode tests will skip`,
    );
    return false;
  }
  for (const [name, clip] of Object.entries(CLIPS)) {
    const out = fixturePath(name);
    if (await exists(out)) continue;
    console.log(`[fixtures] generating ${name}`);
    await run(clipArgs(clip, out));
  }
  for (const [name, args] of Object.entries(DEGENERATE)) {
    const out = fixturePath(name);
    if (await exists(out)) continue;
    console.log(`[fixtures] generating ${name}`);
    await run(args(out));
  }
  for (const [name, make] of Object.entries(BROKEN)) {
    const out = fixturePath(name);
    if (await exists(out)) continue;
    await writeFile(out, await make());
  }
  return true;
}

/** Vitest globalSetup hook. */
export async function setup(): Promise<void> {
  await generateFixtures();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ok = await generateFixtures();
  console.log(ok ? `[fixtures] ready in ${FIXTURES_DIR}` : '[fixtures] skipped');
}
