/**
 * File layout produced by FFmpeg's `dash` muxer (with `hls_playlist` on) inside `videos/<id>/`.
 * Stream N is the N-th `-map`ped output: video rungs first (ascending), then the audio track.
 */
export const HLS_MASTER = 'master.m3u8';
export const DASH_MANIFEST = 'master.mpd';

export const PACKAGE_FORMATS = ['hls', 'dash'] as const;
export type PackageFormat = (typeof PACKAGE_FORMATS)[number];

export function mediaPlaylistName(streamIndex: number): string {
  return `media_${streamIndex}.m3u8`;
}

export function initSegmentName(streamIndex: number): string {
  return `init-stream${streamIndex}.m4s`;
}

export function chunkSegmentPattern(streamIndex: number): RegExp {
  return new RegExp(`^chunk-stream${streamIndex}-\\d+\\.m4s$`);
}

export const MEDIA_PLAYLIST_PATTERN = /^media_\d+\.m3u8$/;

/**
 * Decide which output files to publish. Segments and per-rendition playlists are always kept
 * (the media playlists are tiny and useful for debugging); the master manifests follow
 * `PACKAGE_FORMATS`.
 */
export function selectUploads(
  files: readonly string[],
  formats: readonly PackageFormat[],
): { files: string[]; hlsMaster: string | null; dashManifest: string | null } {
  const hls = formats.includes('hls');
  const dash = formats.includes('dash');
  const keep = files.filter((f) => {
    if (f === HLS_MASTER) return hls;
    if (f === DASH_MANIFEST) return dash;
    return true;
  });
  return {
    files: keep,
    hlsMaster: hls && files.includes(HLS_MASTER) ? HLS_MASTER : null,
    dashManifest: dash && files.includes(DASH_MANIFEST) ? DASH_MANIFEST : null,
  };
}
