import { describe, expect, it } from 'vitest';

import {
  buildLadderArgs,
  chunkSegmentPattern,
  injectDashSubtitles,
  injectHlsSubtitles,
  parseAttributeList,
  parseHlsMaster,
  parseIsoDuration,
  parseMpd,
  selectUploads,
  type SubtitleTrackRef,
} from '../../src/lib/packaging/index.js';
import {
  AV1_LADDER,
  GOP_SECONDS,
  H264_LADDER,
  planLadder,
  SEGMENT_SECONDS,
  type MediaInfo,
} from '../../src/lib/transcode/index.js';

const source = (over: Partial<MediaInfo> = {}): MediaInfo => ({
  formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
  durationSeconds: 10,
  width: 1920,
  height: 1080,
  frameRate: 30,
  videoCodec: 'h264',
  audioCodec: 'aac',
  hasVideo: true,
  hasAudio: true,
  bitrateKbps: 4000,
  ...over,
});

describe('buildLadderArgs', () => {
  it('encodes every rung in one pass and packages DASH + HLS over shared segments', () => {
    const plans = planLadder(H264_LADDER, source());
    const args = buildLadderArgs('/in/src.mp4', plans, { preset: 'veryfast' });
    const joined = args.join(' ');

    expect(args.slice(0, 3)).toEqual(['-y', '-i', '/in/src.mp4']);
    expect(args[args.indexOf('-filter_complex') + 1]).toBe(
      '[0:v]split=4[s0][s1][s2][s3];' +
        '[s0]scale=640:360,format=yuv420p[v0];' +
        '[s1]scale=854:480,format=yuv420p[v1];' +
        '[s2]scale=1280:720,format=yuv420p[v2];' +
        '[s3]scale=1920:1080,format=yuv420p[v3]',
    );
    expect(joined).toContain('-map [v0] -map [v1] -map [v2] -map [v3] -map 0:a:0');
    expect(joined).toContain(`-g ${GOP_SECONDS * 30} -keyint_min ${GOP_SECONDS * 30}`);
    expect(joined).toContain(`-force_key_frames expr:gte(t,n_forced*${GOP_SECONDS})`);
    expect(joined).toContain(
      '-c:v:0 libx264 -preset:v:0 veryfast -profile:v:0 high -sc_threshold:v:0 0 ' +
        '-b:v:0 800k -maxrate:v:0 856k -bufsize:v:0 1600k',
    );
    expect(joined).toContain('-c:v:3 libx264 -preset:v:3 veryfast');
    expect(joined).toContain('-b:v:3 5000k -maxrate:v:3 5350k -bufsize:v:3 10000k');
    expect(joined).toContain('-c:a aac -b:a 128k -ar 48000 -ac 2');
    expect(joined).toContain(
      `-f dash -seg_duration ${SEGMENT_SECONDS} -use_template 1 -use_timeline 1`,
    );
    expect(joined).toContain('-adaptation_sets id=0,streams=0,1,2,3 id=1,streams=4');
    expect(joined).toContain('-hls_playlist 1 -hls_master_name master.m3u8 master.mpd');
    expect(args.at(-1)).toBe('master.mpd');
  });

  it('adds AV1 rungs as a second adaptation set with SVT-AV1 in target-bitrate VBR', () => {
    const info = source({ width: 854, height: 480 });
    const plans = [...planLadder(H264_LADDER, info), ...planLadder(AV1_LADDER, info)];
    expect(plans.map((p) => p.profile.name)).toEqual([
      'h264_360p',
      'h264_480p',
      'av1_360p',
      'av1_480p',
    ]);
    const joined = buildLadderArgs('/in/src.mp4', plans, {
      preset: 'veryfast',
      av1Preset: 10,
    }).join(' ');
    expect(joined).toContain('-c:v:1 libx264 -preset:v:1 veryfast');
    expect(joined).toContain('-c:v:2 libsvtav1 -preset:v:2 10 -b:v:2 500k');
    expect(joined).toContain('-c:v:3 libsvtav1 -preset:v:3 10 -b:v:3 900k');
    // No VBV caps or x264-only flags leak onto the AV1 streams.
    expect(joined).not.toContain('-maxrate:v:2');
    expect(joined).not.toContain('-profile:v:2');
    expect(joined).not.toContain('-sc_threshold:v:3');
    expect(joined).toContain('-adaptation_sets id=0,streams=0,1 id=1,streams=2,3 id=2,streams=4');
  });

  it('skips the split filter and audio for a single silent rung', () => {
    const plans = planLadder(H264_LADDER, source({ width: 320, height: 240, hasAudio: false }));
    expect(plans).toHaveLength(1);
    const args = buildLadderArgs('/in/s.mp4', plans, { preset: 'medium' });
    const joined = args.join(' ');
    expect(args[args.indexOf('-filter_complex') + 1]).toBe('[0:v]scale=320:240,format=yuv420p[v0]');
    expect(joined).not.toContain('0:a:0');
    expect(joined).not.toContain('-c:a');
    expect(joined).toContain('-adaptation_sets id=0,streams=0 -hls_playlist');
  });

  it('adds the watermark as a second input, composited once before the split', () => {
    const plans = planLadder(H264_LADDER, source({ width: 854, height: 480 }));
    const args = buildLadderArgs('/in/src.mp4', plans, {
      preset: 'medium',
      watermark: { imagePath: '/logo.png', position: 'bottom-right', opacity: 0.4 },
    });
    expect(args.slice(0, 5)).toEqual(['-y', '-i', '/in/src.mp4', '-i', '/logo.png']);
    const graph = args[args.indexOf('-filter_complex') + 1]!;
    expect(graph).toBe(
      '[1:v]format=rgba,colorchannelmixer=aa=0.4[wmlogo];' +
        '[0:v][wmlogo]overlay=main_w-overlay_w-main_w*0.02:main_h-overlay_h-main_h*0.02[wmbase];' +
        '[wmbase]split=2[s0][s1];' +
        '[s0]scale=640:360,format=yuv420p[v0];' +
        '[s1]scale=854:480,format=yuv420p[v1]',
    );
  });

  it('feeds the watermarked frames to a single rung too', () => {
    const plans = planLadder(H264_LADDER, source({ width: 320, height: 240 }));
    const graph = buildLadderArgs('/in/src.mp4', plans, {
      preset: 'medium',
      watermark: { imagePath: '/logo.png', position: 'top-left', opacity: 1 },
    })
      .join(' ')
      .split('-filter_complex ')[1]!
      .split(' -map')[0];
    expect(graph).toContain('[wmbase]scale=320:240,format=yuv420p[v0]');
    expect(graph).not.toContain('split=');
  });

  it('refuses an empty ladder and defaults the AV1 preset to 8', () => {
    expect(() => buildLadderArgs('/in/s.mp4', [], { preset: 'medium' })).toThrow(/at least one/);
    const plans = planLadder(AV1_LADDER, source({ width: 320, height: 240 }));
    expect(buildLadderArgs('/in/s.mp4', plans, { preset: 'medium' }).join(' ')).toContain(
      '-c:v:0 libsvtav1 -preset:v:0 8 -b:v:0 500k',
    );
  });
});

describe('selectUploads', () => {
  const files = [
    'chunk-stream0-00001.m4s',
    'init-stream0.m4s',
    'master.m3u8',
    'master.mpd',
    'media_0.m3u8',
  ];

  it('publishes both masters by default and drops the one not requested', () => {
    expect(selectUploads(files, ['hls', 'dash'])).toEqual({
      files,
      hlsMaster: 'master.m3u8',
      dashManifest: 'master.mpd',
    });
    const hlsOnly = selectUploads(files, ['hls']);
    expect(hlsOnly.files).not.toContain('master.mpd');
    expect(hlsOnly).toMatchObject({ hlsMaster: 'master.m3u8', dashManifest: null });
    const dashOnly = selectUploads(files, ['dash']);
    expect(dashOnly.files).not.toContain('master.m3u8');
    expect(dashOnly.files).toContain('media_0.m3u8');
    expect(dashOnly).toMatchObject({ hlsMaster: null, dashManifest: 'master.mpd' });
  });

  it('matches chunk names per stream', () => {
    expect(chunkSegmentPattern(0).test('chunk-stream0-00001.m4s')).toBe(true);
    expect(chunkSegmentPattern(0).test('chunk-stream10-00001.m4s')).toBe(false);
    expect(chunkSegmentPattern(1).test('init-stream1.m4s')).toBe(false);
  });
});

const MPD = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" profiles="urn:mpeg:dash:profile:isoff-live:2011" type="static" mediaPresentationDuration="PT0H0M10.0S" minBufferTime="PT8.0S">
  <Period id="0" start="PT0.0S">
    <AdaptationSet id="0" contentType="video" startWithSAP="1" segmentAlignment="true" frameRate="30/1" maxWidth="1280" maxHeight="720" par="16:9">
      <Representation id="0" mimeType="video/mp4" codecs="avc1.42c01e" bandwidth="800000" width="640" height="360" sar="1:1">
        <SegmentTemplate timescale="15360" initialization="init-stream$RepresentationID$.m4s" media="chunk-stream$RepresentationID$-$Number%05d$.m4s" startNumber="1"></SegmentTemplate>
      </Representation>
      <Representation id="1" mimeType="video/mp4" codecs="avc1.42c01f" bandwidth="2800000" width="1280" height="720" sar="1:1">
      </Representation>
    </AdaptationSet>
    <AdaptationSet id="1" contentType="audio" startWithSAP="1" segmentAlignment="true" lang="und">
      <Representation id="2" mimeType="audio/mp4" codecs="mp4a.40.2" bandwidth="128000" audioSamplingRate="48000">
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

const MASTER = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_A1",NAME="audio_2",DEFAULT=YES,CHANNELS="2",URI="media_2.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=932157,RESOLUTION=640x360,CODECS="avc1.42c01e,mp4a.40.2",AUDIO="group_A1"
media_0.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=2929867,RESOLUTION=1280x720,CODECS="avc1.42c01f,mp4a.40.2",AUDIO="group_A1"
media_1.m3u8
`;

describe('subtitle injection', () => {
  const tracks: SubtitleTrackRef[] = [
    {
      language: 'en',
      label: 'English',
      isDefault: true,
      hlsPlaylistUri: 'subtitles/en.m3u8',
      vttUri: 'subtitles/en.vtt',
    },
    {
      language: 'pt-BR',
      label: 'Portugues "BR"',
      isDefault: false,
      hlsPlaylistUri: 'subtitles/pt-BR.m3u8',
      vttUri: 'subtitles/pt-BR.vtt',
    },
  ];

  it('declares the tracks and points every HLS variant at the group', () => {
    const injected = injectHlsSubtitles(MASTER, tracks);
    const lines = injected.split('\n');

    const media = lines.filter((l) => l.startsWith('#EXT-X-MEDIA:TYPE=SUBTITLES'));
    expect(media).toHaveLength(2);
    expect(media[0]).toContain('GROUP-ID="subs"');
    expect(media[0]).toContain('NAME="English"');
    expect(media[0]).toContain('LANGUAGE="en"');
    expect(media[0]).toContain('DEFAULT=YES');
    expect(media[0]).toContain('URI="subtitles/en.m3u8"');
    expect(media[1]).toContain('DEFAULT=NO');
    // Quotes inside a label would break the attribute list.
    expect(media[1]).toContain(`NAME="Portugues 'BR'"`);

    const variants = lines.filter((l) => l.startsWith('#EXT-X-STREAM-INF:'));
    expect(variants).toHaveLength(2);
    expect(variants.every((l) => l.endsWith(',SUBTITLES="subs"'))).toBe(true);
    // Declarations come before the first variant, and the audio group is untouched.
    expect(lines.indexOf(media[0]!)).toBeLessThan(lines.indexOf(variants[0]!));
    expect(injected).toContain('TYPE=AUDIO,GROUP-ID="group_A1"');
    // The variant URIs still follow their #EXT-X-STREAM-INF lines.
    expect(parseHlsMaster(injected).variants.map((v) => v.uri)).toEqual([
      'media_0.m3u8',
      'media_1.m3u8',
    ]);
  });

  it('leaves manifests alone when there are no tracks and never double-tags a variant', () => {
    expect(injectHlsSubtitles(MASTER, [])).toBe(MASTER);
    expect(injectDashSubtitles(MPD, [])).toBe(MPD);

    // Injection always starts from the stored manifest, but a variant that already points at
    // the group must not be tagged twice.
    const twice = injectHlsSubtitles(injectHlsSubtitles(MASTER, tracks), tracks);
    expect(/,SUBTITLES="subs",SUBTITLES="subs"/.exec(twice)).toBeNull();
    expect(twice.split(',SUBTITLES="subs"').length - 1).toBe(2);
  });

  it('adds a DASH text adaptation set per track, after the existing ids', () => {
    const injected = injectDashSubtitles(MPD, tracks);
    expect(injected).toContain(
      '<AdaptationSet id="2" contentType="text" mimeType="text/vtt" lang="en">',
    );
    expect(injected).toContain(
      '<AdaptationSet id="3" contentType="text" mimeType="text/vtt" lang="pt-BR">',
    );
    expect(injected).toContain('<BaseURL>subtitles/en.vtt</BaseURL>');
    expect(injected).toContain('value="subtitle"');
    expect(injected.indexOf('</Period>')).toBeGreaterThan(injected.indexOf('subtitles/pt-BR.vtt'));
    // The existing representations survive unchanged.
    const mpd = parseMpd(injected);
    expect(mpd.adaptationSets).toBe(4);
    expect(mpd.representations.filter((r) => r.contentType === 'video')).toHaveLength(2);
  });
});

describe('manifest readers', () => {
  it('parses ISO durations', () => {
    expect(parseIsoDuration('PT0H0M10.0S')).toBe(10);
    expect(parseIsoDuration('PT1H2M3.5S')).toBe(3723.5);
    expect(parseIsoDuration('P1DT1S')).toBe(86_401);
    expect(parseIsoDuration('10s')).toBeNull();
  });

  it('reads representations out of an MPD', () => {
    const mpd = parseMpd(MPD);
    expect(mpd.durationSeconds).toBe(10);
    expect(mpd.adaptationSets).toBe(2);
    expect(mpd.representations).toEqual([
      {
        id: '0',
        contentType: 'video',
        mimeType: 'video/mp4',
        codecs: 'avc1.42c01e',
        bandwidth: 800_000,
        width: 640,
        height: 360,
      },
      {
        id: '1',
        contentType: 'video',
        mimeType: 'video/mp4',
        codecs: 'avc1.42c01f',
        bandwidth: 2_800_000,
        width: 1280,
        height: 720,
      },
      {
        id: '2',
        contentType: 'audio',
        mimeType: 'audio/mp4',
        codecs: 'mp4a.40.2',
        bandwidth: 128_000,
        width: null,
        height: null,
      },
    ]);
  });

  it('parses HLS attribute lists with quoted commas', () => {
    expect(parseAttributeList('BANDWIDTH=1,CODECS="a,b",AUDIO="g"')).toEqual({
      BANDWIDTH: '1',
      CODECS: 'a,b',
      AUDIO: 'g',
    });
  });

  it('reads variants and media groups out of an HLS master playlist', () => {
    const master = parseHlsMaster(MASTER);
    expect(master.media).toEqual([
      { type: 'AUDIO', groupId: 'group_A1', name: 'audio_2', uri: 'media_2.m3u8', isDefault: true },
    ]);
    expect(master.variants).toEqual([
      {
        uri: 'media_0.m3u8',
        bandwidth: 932_157,
        width: 640,
        height: 360,
        codecs: 'avc1.42c01e,mp4a.40.2',
        audioGroup: 'group_A1',
      },
      {
        uri: 'media_1.m3u8',
        bandwidth: 2_929_867,
        width: 1280,
        height: 720,
        codecs: 'avc1.42c01f,mp4a.40.2',
        audioGroup: 'group_A1',
      },
    ]);
  });
});
