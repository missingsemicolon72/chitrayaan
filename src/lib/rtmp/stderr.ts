/** Why a publisher was turned away after connecting. */
export type RejectReason = 'stream-key' | 'app';

export interface LiveVideoInfo {
  codec: string;
  width: number | null;
  height: number | null;
  fps: number | null;
}

export interface LiveAudioInfo {
  codec: string;
  sampleRate: number | null;
  /** FFmpeg's channel layout name, e.g. `stereo` or `5.1(side)`. */
  channels: string | null;
}

/** What the publisher is sending, as FFmpeg described it once the stream started. */
export interface LiveInputInfo {
  video: LiveVideoInfo | null;
  audio: LiveAudioInfo | null;
}

/** The listener stderr lines that change what the listener does. Everything else is noise. */
export type ListenerEvent =
  | { kind: 'rejected'; reason: RejectReason }
  | { kind: 'listen-failed' }
  | { kind: 'input'; info: LiveInputInfo };

// FFmpeg only warns about these and carries on, which is why they have to be caught here.
const WRONG_STREAM_KEY = /Unexpected stream .*, expecting /;
const WRONG_APP = /App field don't match up|App field not found in connect/;
// No connection was accepted: either the port could not be bound (taken, not permitted) or the
// wait for a publisher timed out. FFmpeg prints the same line for both; timing tells them apart.
const LISTEN_FAILED = /Cannot open connection tcp:\/\/\S*\?listen/;
const INPUT_HEADER = /\bInput #0, flv\b/;
const STREAM_LINE = /^\s*Stream #0:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?: (Video|Audio): (.+)$/;

/** Strip FFmpeg's `[component @ 0x...]` and `[level]` prefixes, keeping indentation. */
function messageOf(line: string): string {
  return line.replace(/^(?:\[[^\]]*\] ?)+/, '');
}

function parseVideo(detail: string): LiveVideoInfo {
  const codec = /^([\w-]+)/.exec(detail)?.[1] ?? 'unknown';
  const size = /(?:^|[\s,])(\d{2,5})x(\d{2,5})(?=[\s,[]|$)/.exec(detail);
  const fps = /(\d+(?:\.\d+)?) fps\b/.exec(detail);
  return {
    codec,
    width: size ? Number(size[1]) : null,
    height: size ? Number(size[2]) : null,
    fps: fps ? Number(fps[1]) : null,
  };
}

function parseAudio(detail: string): LiveAudioInfo {
  const fields = detail.split(', ');
  const codec = /^([\w-]+)/.exec(detail)?.[1] ?? 'unknown';
  const hzIndex = fields.findIndex((field) => /^\d+ Hz$/.test(field));
  return {
    codec,
    sampleRate: hzIndex === -1 ? null : Number.parseInt(fields[hzIndex] ?? '', 10),
    channels: hzIndex === -1 ? null : (fields[hzIndex + 1]?.trim() ?? null),
  };
}

/**
 * Turns the listener's stderr, line by line, into the few events that matter. Stateful because
 * FFmpeg describes the input over several lines and then describes the output in the same
 * format, so stream lines only count while the input description is being printed.
 */
export class ListenerOutputParser {
  private input: LiveInputInfo | null = null;

  feed(line: string): ListenerEvent | null {
    if (WRONG_STREAM_KEY.test(line)) return { kind: 'rejected', reason: 'stream-key' };
    if (WRONG_APP.test(line)) return { kind: 'rejected', reason: 'app' };
    if (LISTEN_FAILED.test(line)) return { kind: 'listen-failed' };

    const message = messageOf(line);
    if (this.input === null) {
      if (INPUT_HEADER.test(message)) this.input = { video: null, audio: null };
      return null;
    }

    // The input description is the indented block under the header; the first line that is
    // not indented ("Stream mapping:", "Output #0, ...") ends it.
    if (/^\s/.test(message)) {
      const stream = STREAM_LINE.exec(message);
      if (stream?.[1] === 'Video' && this.input.video === null) {
        this.input.video = parseVideo(stream[2] ?? '');
      } else if (stream?.[1] === 'Audio' && this.input.audio === null) {
        this.input.audio = parseAudio(stream[2] ?? '');
      }
      return null;
    }

    const info = this.input;
    this.input = null;
    return { kind: 'input', info };
  }
}

/** Replace every occurrence of `secret` in `text`, so FFmpeg output can be logged safely. */
export function redact(text: string, secret: string): string {
  return secret === '' ? text : text.split(secret).join('***');
}
