/**
 * Subtitle tracks are uploaded independently of transcoding, so they are woven into the
 * manifests when those are served rather than baked in at packaging time. That keeps a single
 * copy of the packaged output on disk and makes an added or removed track visible immediately.
 */

export const SUBTITLE_GROUP_ID = 'subs';

export interface SubtitleTrackRef {
  language: string;
  label: string;
  isDefault: boolean;
  /** URI relative to the manifest, e.g. `subtitles/en.m3u8`. */
  hlsPlaylistUri: string;
  /** URI relative to the manifest, e.g. `subtitles/en.vtt`. */
  vttUri: string;
}

const quoted = (value: string) => value.replace(/"/g, "'");

const xmlEscape = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Add `#EXT-X-MEDIA:TYPE=SUBTITLES` entries to an HLS master playlist and point every variant
 * at the subtitle group. Returns the playlist unchanged when there are no tracks.
 */
export function injectHlsSubtitles(master: string, tracks: readonly SubtitleTrackRef[]): string {
  if (tracks.length === 0) return master;

  const mediaLines = tracks.map(
    (track) =>
      `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="${SUBTITLE_GROUP_ID}",NAME="${quoted(track.label)}",` +
      `LANGUAGE="${quoted(track.language)}",DEFAULT=${track.isDefault ? 'YES' : 'NO'},` +
      `AUTOSELECT=YES,FORCED=NO,URI="${quoted(track.hlsPlaylistUri)}"`,
  );

  const lines = master.split(/\r?\n/);
  const out: string[] = [];
  let inserted = false;
  for (const line of lines) {
    if (!inserted && line.startsWith('#EXT-X-STREAM-INF:')) {
      out.push(...mediaLines);
      inserted = true;
    }
    out.push(
      line.startsWith('#EXT-X-STREAM-INF:') && !line.includes('SUBTITLES=')
        ? `${line},SUBTITLES="${SUBTITLE_GROUP_ID}"`
        : line,
    );
  }
  // A master with no variants (should not happen) still gets the media declarations.
  if (!inserted) out.push(...mediaLines);
  return out.join('\n');
}

/** Add a text `<AdaptationSet>` per track to a DASH manifest, just before `</Period>`. */
export function injectDashSubtitles(mpd: string, tracks: readonly SubtitleTrackRef[]): string {
  if (tracks.length === 0) return mpd;

  const usedIds = [...mpd.matchAll(/<AdaptationSet\b[^>]*\bid="(\d+)"/g)].map((m) => Number(m[1]));
  let nextId = usedIds.length > 0 ? Math.max(...usedIds) + 1 : 0;

  const blocks = tracks
    .map((track) => {
      const id = nextId;
      nextId += 1;
      return [
        `    <AdaptationSet id="${id}" contentType="text" mimeType="text/vtt" lang="${xmlEscape(track.language)}">`,
        '      <Role schemeIdUri="urn:mpeg:dash:role:2011" value="subtitle"/>',
        `      <Representation id="subtitle_${xmlEscape(track.language)}" bandwidth="256">`,
        `        <BaseURL>${xmlEscape(track.vttUri)}</BaseURL>`,
        '      </Representation>',
        '    </AdaptationSet>',
      ].join('\n');
    })
    .join('\n');

  const closing = mpd.lastIndexOf('</Period>');
  if (closing === -1) return mpd;
  return `${mpd.slice(0, closing)}${blocks}\n  ${mpd.slice(closing)}`;
}
