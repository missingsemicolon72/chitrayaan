import { spawn } from 'node:child_process';

import { z } from 'zod';

import { TailBuffer } from './ffmpeg.js';

export class ProbeError extends Error {
  constructor(
    message: string,
    public readonly stderrTail = '',
  ) {
    super(stderrTail ? `${message}\n${stderrTail}` : message);
    this.name = 'ProbeError';
  }
}

export interface MediaInfo {
  formatName: string;
  durationSeconds: number;
  /** Display dimensions (rotation metadata applied), null without a video stream. */
  width: number | null;
  height: number | null;
  frameRate: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  hasVideo: boolean;
  hasAudio: boolean;
  bitrateKbps: number | null;
}

const numericString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/)
  .transform(Number);

const streamSchema = z.object({
  codec_type: z.string().optional(),
  codec_name: z.string().optional(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  duration: numericString.optional(),
  avg_frame_rate: z.string().optional(),
  r_frame_rate: z.string().optional(),
  disposition: z.object({ attached_pic: z.number().optional() }).partial().optional(),
  tags: z.record(z.string(), z.string()).optional(),
  side_data_list: z.array(z.object({ rotation: z.number().optional() }).partial()).optional(),
});

const ffprobeOutputSchema = z.object({
  format: z
    .object({
      format_name: z.string().optional(),
      duration: numericString.optional(),
      bit_rate: numericString.optional(),
    })
    .optional(),
  streams: z.array(streamSchema).default([]),
});

function parseRate(rate: string | undefined): number | null {
  if (!rate) return null;
  const [num, den] = rate.split('/').map(Number);
  if (num === undefined || !Number.isFinite(num) || num <= 0) return null;
  if (den === undefined) return num;
  if (!Number.isFinite(den) || den <= 0) return null;
  return num / den;
}

function rotationOf(stream: z.infer<typeof streamSchema>): number {
  const fromSideData = stream.side_data_list?.find((d) => typeof d.rotation === 'number');
  const raw = fromSideData?.rotation ?? Number(stream.tags?.rotate ?? 0);
  return Number.isFinite(raw) ? ((Math.round(raw) % 360) + 360) % 360 : 0;
}

/** Turn raw ffprobe JSON into `MediaInfo`. Exported for unit tests. */
export function interpretProbeOutput(json: unknown): MediaInfo {
  const parsed = ffprobeOutputSchema.safeParse(json);
  if (!parsed.success) throw new ProbeError('ffprobe output was not in the expected shape');
  const { format, streams } = parsed.data;

  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const audio = streams.find((s) => s.codec_type === 'audio');

  const duration = format?.duration ?? video?.duration ?? audio?.duration;
  if (duration === undefined || !Number.isFinite(duration) || duration <= 0) {
    throw new ProbeError('could not determine media duration');
  }

  let width = video?.width ?? null;
  let height = video?.height ?? null;
  if (video && width !== null && height !== null) {
    const rotation = rotationOf(video);
    if (rotation === 90 || rotation === 270) [width, height] = [height, width];
  }

  return {
    formatName: format?.format_name ?? 'unknown',
    durationSeconds: duration,
    width,
    height,
    frameRate: video ? (parseRate(video.avg_frame_rate) ?? parseRate(video.r_frame_rate)) : null,
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio?.codec_name ?? null,
    hasVideo: video !== undefined,
    hasAudio: audio !== undefined,
    bitrateKbps: format?.bit_rate !== undefined ? Math.round(format.bit_rate / 1000) : null,
  };
}

export interface ProbeOptions {
  ffprobePath?: string;
}

/** Inspect a media file with ffprobe. Rejects with `ProbeError` for unreadable input. */
export function probe(filePath: string, options: ProbeOptions = {}): Promise<MediaInfo> {
  const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath];
  return new Promise((resolve, reject) => {
    const child = spawn(options.ffprobePath ?? 'ffprobe', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    const stderr = new TailBuffer(20);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => stderr.push(chunk));
    child.once('error', (err) => reject(new ProbeError(`could not start ffprobe: ${err.message}`)));
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new ProbeError(`ffprobe exited with code ${String(code)}`, stderr.toString()));
        return;
      }
      try {
        resolve(interpretProbeOutput(JSON.parse(stdout)));
      } catch (err) {
        reject(
          err instanceof ProbeError
            ? new ProbeError(err.message, stderr.toString())
            : new ProbeError('ffprobe produced unparseable output', stderr.toString()),
        );
      }
    });
  });
}
