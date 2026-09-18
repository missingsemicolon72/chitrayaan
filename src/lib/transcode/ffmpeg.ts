import { spawn } from 'node:child_process';
import readline from 'node:readline';

/** Keeps only the last `maxLines` lines of a chunked text stream (FFmpeg stderr can be huge). */
export class TailBuffer {
  private lines: string[] = [];
  private partial = '';

  constructor(private readonly maxLines = 40) {}

  push(chunk: string): void {
    const parts = (this.partial + chunk).split(/\r?\n|\r/);
    this.partial = parts.pop() ?? '';
    for (const line of parts) {
      if (line.trim().length === 0) continue;
      this.lines.push(line);
      if (this.lines.length > this.maxLines) this.lines.shift();
    }
  }

  toString(): string {
    const all = this.partial.trim() ? [...this.lines, this.partial] : this.lines;
    return all.slice(-this.maxLines).join('\n');
  }
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number | null,
    public readonly signal: NodeJS.Signals | null,
    public readonly stderrTail: string,
    public readonly args: readonly string[],
  ) {
    super(stderrTail ? `${message}\n${stderrTail}` : message);
    this.name = 'FfmpegError';
  }
}

export interface FfmpegProgress {
  /** Output timestamp reached so far, in seconds. */
  outTimeSeconds: number;
  /** 0-100 when the total duration is known, else null. */
  percent: number | null;
  fps: number | null;
  /** e.g. `2.5x`: encode speed relative to real time. */
  speed: string | null;
}

/** Parse one `-progress` block (key=value lines) into a progress sample. */
export function parseProgressBlock(
  block: Record<string, string>,
  durationSeconds: number | undefined,
): FfmpegProgress {
  const us = block.out_time_us ?? block.out_time_ms; // both are microseconds in practice
  let outTimeSeconds = 0;
  if (us !== undefined && /^-?\d+$/.test(us)) {
    outTimeSeconds = Math.max(0, Number(us) / 1_000_000);
  } else if (block.out_time) {
    const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(block.out_time);
    if (m) outTimeSeconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  }
  const percent =
    durationSeconds && durationSeconds > 0
      ? Math.min(100, (outTimeSeconds / durationSeconds) * 100)
      : null;
  const fps = block.fps !== undefined && block.fps !== '' ? Number(block.fps) : null;
  return {
    outTimeSeconds,
    percent,
    fps: fps !== null && Number.isFinite(fps) ? fps : null,
    speed: block.speed?.trim() ? block.speed.trim() : null,
  };
}

export interface RunFfmpegOptions {
  ffmpegPath?: string;
  /** Working directory; relative output paths in `args` resolve against it. */
  cwd?: string;
  /** Total output duration, used to turn timestamps into a percentage. */
  durationSeconds?: number;
  onProgress?: (progress: FfmpegProgress) => void;
  signal?: AbortSignal;
}

export interface RunFfmpegResult {
  stderrTail: string;
}

/**
 * Run FFmpeg with structured progress on stdout (`-progress pipe:1`) and only errors on stderr.
 * Rejects with `FfmpegError` (carrying the last lines of stderr) on a non-zero exit or signal.
 */
export function runFfmpeg(
  args: readonly string[],
  options: RunFfmpegOptions = {},
): Promise<RunFfmpegResult> {
  const fullArgs = [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-nostats',
    '-progress',
    'pipe:1',
    ...args,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(options.ffmpegPath ?? 'ffmpeg', fullArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(options.cwd ? { cwd: options.cwd } : {}),
    });

    const stderr = new TailBuffer();
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => stderr.push(chunk));

    let block: Record<string, string> = {};
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      const eq = line.indexOf('=');
      if (eq === -1) return;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (key === 'progress') {
        options.onProgress?.(parseProgressBlock(block, options.durationSeconds));
        block = {};
      } else {
        block[key] = value;
      }
    });

    const onAbort = () => child.kill('SIGKILL');
    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.once('error', (err) => {
      options.signal?.removeEventListener('abort', onAbort);
      reject(new FfmpegError(`could not start ffmpeg: ${err.message}`, null, null, '', fullArgs));
    });

    child.once('close', (code, signal) => {
      options.signal?.removeEventListener('abort', onAbort);
      const tail = stderr.toString();
      if (options.signal?.aborted) {
        reject(new FfmpegError('ffmpeg was aborted', code, signal, tail, fullArgs));
      } else if (code === 0) {
        resolve({ stderrTail: tail });
      } else {
        const why = signal ? `killed by ${signal}` : `exited with code ${String(code)}`;
        reject(new FfmpegError(`ffmpeg ${why}`, code, signal, tail, fullArgs));
      }
    });
  });
}

/** First line of `<binary> -version`, or a rejection if it cannot be executed. */
export function binaryVersion(binaryPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, ['-version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    child.once('error', (err) => reject(new Error(`cannot run ${binaryPath}: ${err.message}`)));
    child.once('close', (code) => {
      if (code === 0) resolve(out.split(/\r?\n/)[0] ?? '');
      else reject(new Error(`${binaryPath} -version exited with code ${String(code)}`));
    });
  });
}
