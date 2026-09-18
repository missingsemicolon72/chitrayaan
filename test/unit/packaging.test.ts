import { describe, expect, it } from 'vitest';

import {
  buildLadderArgs,
  chunkSegmentPattern,
  parseAttributeList,
  parseHlsMaster,
  parseIsoDuration,
  parseMpd,
  selectUploads,
} from '../../src/lib/packaging/index.js';
import {
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
    expect(joined).toContain('-c:v libx264 -preset veryfast -profile:v high');
    expect(joined).toContain(
      `-g ${GOP_SECONDS * 30} -keyint_min ${GOP_SECONDS * 30} -sc_threshold 0`,
    );
    expect(joined).toContain(`-force_key_frames expr:gte(t,n_forced*${GOP_SECONDS})`);
    expect(joined).toContain('-b:v:0 800k -maxrate:v:0 856k -bufsize:v:0 1600k');
    expect(joined).toContain('-b:v:3 5000k -maxrate:v:3 5350k -bufsize:v:3 10000k');
    expect(joined).toContain('-c:a aac -b:a 128k -ar 48000 -ac 2');
    expect(joined).toContain(
      `-f dash -seg_duration ${SEGMENT_SECONDS} -use_template 1 -use_timeline 1`,
    );
    expect(joined).toContain('-adaptation_sets id=0,streams=v id=1,streams=a');
    expect(joined).toContain('-hls_playlist 1 -hls_master_name master.m3u8 master.mpd');
    expect(args.at(-1)).toBe('master.mpd');
  });

  it('skips the split filter and audio for a single silent rung', () => {
    const plans = planLadder(H264_LADDER, source({ width: 320, height: 240, hasAudio: false }));
    expect(plans).toHaveLength(1);
    const args = buildLadderArgs('/in/s.mp4', plans, { preset: 'medium' });
    const joined = args.join(' ');
    expect(args[args.indexOf('-filter_complex') + 1]).toBe('[0:v]scale=320:240,format=yuv420p[v0]');
    expect(joined).not.toContain('0:a:0');
    expect(joined).not.toContain('-c:a');
    expect(joined).toContain('-adaptation_sets id=0,streams=v -hls_playlist');
  });

  it('refuses an empty ladder or non-h264 rungs', () => {
    expect(() => buildLadderArgs('/in/s.mp4', [], { preset: 'medium' })).toThrow(/at least one/);
    const plans = planLadder([{ ...H264_LADDER[0]!, codec: 'av1', name: 'av1_360p' }], source());
    expect(() => buildLadderArgs('/in/s.mp4', plans, { preset: 'medium' })).toThrow(/Milestone 8/);
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
