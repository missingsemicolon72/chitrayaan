/**
 * Small, dependency-free readers for the manifests FFmpeg writes. Used to validate a transcode's
 * output and in tests; not a general-purpose parser.
 */

export interface MpdRepresentation {
  id: string;
  contentType: string;
  mimeType: string | null;
  codecs: string | null;
  bandwidth: number | null;
  width: number | null;
  height: number | null;
}

export interface MpdInfo {
  durationSeconds: number | null;
  /** Number of `<AdaptationSet>` elements (one per codec, plus audio). */
  adaptationSets: number;
  representations: MpdRepresentation[];
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m?.[1] ?? null;
}

function num(value: string | null): number | null {
  if (value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** `PT0H0M10.5S` -> 10.5 */
export function parseIsoDuration(value: string): number | null {
  const m =
    /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
      value,
    );
  if (!m) return null;
  const [, d, h, mi, s] = m;
  return Number(d ?? 0) * 86_400 + Number(h ?? 0) * 3_600 + Number(mi ?? 0) * 60 + Number(s ?? 0);
}

export function parseMpd(xml: string): MpdInfo {
  const mpdTag = /<MPD\b[^>]*>/.exec(xml)?.[0] ?? '';
  const duration = attr(mpdTag, 'mediaPresentationDuration');
  const representations: MpdRepresentation[] = [];
  let adaptationSets = 0;

  const setRe = /<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/g;
  for (const set of xml.matchAll(setRe)) {
    adaptationSets += 1;
    const setTag = `<AdaptationSet${set[1] ?? ''}>`;
    const setContentType =
      attr(setTag, 'contentType') ?? attr(setTag, 'mimeType')?.split('/')[0] ?? 'unknown';
    for (const rep of (set[2] ?? '').matchAll(/<Representation\b[^>]*>/g)) {
      const tag = rep[0];
      const mimeType = attr(tag, 'mimeType');
      representations.push({
        id: attr(tag, 'id') ?? '',
        contentType: mimeType?.split('/')[0] ?? setContentType,
        mimeType,
        codecs: attr(tag, 'codecs'),
        bandwidth: num(attr(tag, 'bandwidth')),
        width: num(attr(tag, 'width')),
        height: num(attr(tag, 'height')),
      });
    }
  }
  return {
    durationSeconds: duration ? parseIsoDuration(duration) : null,
    adaptationSets,
    representations,
  };
}

export interface HlsVariant {
  uri: string;
  bandwidth: number | null;
  width: number | null;
  height: number | null;
  codecs: string | null;
  audioGroup: string | null;
}

export interface HlsMedia {
  type: string;
  groupId: string | null;
  name: string | null;
  uri: string | null;
  isDefault: boolean;
}

export interface HlsMasterInfo {
  variants: HlsVariant[];
  media: HlsMedia[];
}

/** Parse an HLS attribute list (`A=1,B="x,y"`), honouring quoted commas. */
export function parseAttributeList(list: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of list.matchAll(/([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g)) {
    out[m[1]!] = m[3] ?? m[2] ?? '';
  }
  return out;
}

export function parseHlsMaster(text: string): HlsMasterInfo {
  const info: HlsMasterInfo = { variants: [], media: [] };
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = parseAttributeList(line.slice('#EXT-X-MEDIA:'.length));
      info.media.push({
        type: a.TYPE ?? '',
        groupId: a['GROUP-ID'] ?? null,
        name: a.NAME ?? null,
        uri: a.URI ?? null,
        isDefault: a.DEFAULT === 'YES',
      });
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = parseAttributeList(line.slice('#EXT-X-STREAM-INF:'.length));
      let uri = '';
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j]!.trim();
        if (next && !next.startsWith('#')) {
          uri = next;
          i = j;
          break;
        }
      }
      const res = /^(\d+)x(\d+)$/.exec(a.RESOLUTION ?? '');
      info.variants.push({
        uri,
        bandwidth: num(a.BANDWIDTH ?? null),
        width: res ? Number(res[1]) : null,
        height: res ? Number(res[2]) : null,
        codecs: a.CODECS ?? null,
        audioGroup: a.AUDIO ?? null,
      });
    }
  }
  return info;
}
