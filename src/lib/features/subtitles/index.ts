import { InvalidWebVttError } from '../webvtt.js';

export {
  formatVttTimestamp,
  InvalidWebVttError,
  parseVttTimestamp,
  parseWebVtt,
  type WebVttInfo,
} from '../webvtt.js';

/** Uploaded tracks larger than this are rejected before they reach storage. */
export const SUBTITLE_MAX_BYTES = 5 * 1024 * 1024;

/** Storage sub-prefix; kept out of the packaging wipe so a re-transcode preserves tracks. */
export const SUBTITLES_PREFIX = 'subtitles';

/** BCP-47-ish: a 2-3 letter primary subtag plus optional alphanumeric subtags. */
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export class InvalidLanguageError extends Error {
  constructor(language: string) {
    super(
      `invalid language tag ${JSON.stringify(language)}: expected a BCP-47 tag such as "en" or "pt-BR"`,
    );
    this.name = 'InvalidLanguageError';
  }
}

/**
 * Normalise a language tag: lower-case primary subtag, upper-case region (`pt-br` -> `pt-BR`).
 * Throws `InvalidLanguageError` for anything that is not a plausible tag.
 */
export function normalizeLanguage(language: string): string {
  const trimmed = language.trim();
  if (!LANGUAGE_TAG.test(trimmed)) throw new InvalidLanguageError(language);
  const [primary, ...rest] = trimmed.split('-');
  return [
    primary!.toLowerCase(),
    ...rest.map((part) => (part.length === 2 ? part.toUpperCase() : part.toLowerCase())),
  ].join('-');
}

/** A default label when the uploader does not supply one. */
export function defaultLabel(language: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(language) ?? language;
  } catch {
    return language;
  }
}

export function subtitleFileName(language: string): string {
  return `${language}.vtt`;
}

export function subtitleKey(videoId: string, language: string): string {
  return `videos/${videoId}/${SUBTITLES_PREFIX}/${subtitleFileName(language)}`;
}

/**
 * HLS needs a media playlist per subtitle track, not the raw `.vtt`. The playlist is generated
 * on request and sits next to the file it references, so the relative URI always resolves.
 */
export function buildSubtitlePlaylist(language: string, durationSeconds: number): string {
  const duration = Math.max(durationSeconds, 0.001);
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${Math.ceil(duration)}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXTINF:${duration.toFixed(3)},`,
    subtitleFileName(language),
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');
}

/** Validate an uploaded body, throwing `InvalidWebVttError` when it is unusable. */
export function assertSubtitleSize(sizeBytes: number): void {
  if (sizeBytes === 0) throw new InvalidWebVttError('file is empty');
  if (sizeBytes > SUBTITLE_MAX_BYTES) {
    throw new InvalidWebVttError(`file is larger than ${SUBTITLE_MAX_BYTES} bytes`);
  }
}
