/**
 * Minimal WebVTT support shared by the subtitle feature (which validates uploaded files) and
 * the thumbnail feature (which writes a sprite track). Not a full parser: it checks the header
 * and cue timings, which is what the API needs to reject junk before storing it.
 */

export class InvalidWebVttError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWebVttError';
  }
}

/** `HH:MM:SS.mmm` or `MM:SS.mmm` -> seconds; null when the value is not a timestamp. */
export function parseVttTimestamp(value: string): number | null {
  const m = /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)[.,](\d{1,3})$/.exec(value.trim());
  if (!m) return null;
  const [, hours, minutes, seconds, millis] = m;
  return (
    Number(hours ?? 0) * 3600 +
    Number(minutes) * 60 +
    Number(seconds) +
    Number((millis ?? '0').padEnd(3, '0')) / 1000
  );
}

/** Seconds -> `HH:MM:SS.mmm`. */
export function formatVttTimestamp(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const whole = Math.floor(clamped);
  const millis = Math.round((clamped - whole) * 1000);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(Math.floor(whole / 3600))}:${pad(Math.floor(whole / 60) % 60)}:${pad(whole % 60)}.${pad(millis, 3)}`;
}

export interface WebVttInfo {
  cueCount: number;
  /** End time of the last cue, in seconds. */
  lastCueEndSeconds: number;
}

/**
 * Validate a WebVTT document and summarise it. Throws `InvalidWebVttError` for a missing
 * header, malformed timings, or a file without cues.
 */
export function parseWebVtt(text: string): WebVttInfo {
  const body = text.replace(/^\uFEFF/u, '');
  const firstLine = body.split(/\r?\n/, 1)[0] ?? '';
  if (!/^WEBVTT([ \t].*)?$/.test(firstLine.trimEnd())) {
    throw new InvalidWebVttError('file must start with a WEBVTT header line');
  }

  let cueCount = 0;
  let lastCueEndSeconds = 0;
  const lines = body.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.includes('-->')) continue;
    const [startRaw, rest] = line.split('-->');
    const endRaw = (rest ?? '').trim().split(/\s+/)[0] ?? '';
    const start = parseVttTimestamp(startRaw ?? '');
    const end = parseVttTimestamp(endRaw);
    if (start === null || end === null) {
      throw new InvalidWebVttError(`line ${index + 1}: malformed cue timing "${line.trim()}"`);
    }
    if (end < start) {
      throw new InvalidWebVttError(`line ${index + 1}: cue ends before it starts`);
    }
    cueCount += 1;
    lastCueEndSeconds = Math.max(lastCueEndSeconds, end);
  }
  if (cueCount === 0) throw new InvalidWebVttError('file contains no cues');
  return { cueCount, lastCueEndSeconds };
}
