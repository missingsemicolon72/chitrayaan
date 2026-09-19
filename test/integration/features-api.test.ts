import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseHlsMaster, parseMpd } from '../../src/lib/packaging/index.js';
import { createTestApp, type TestApp } from '../helpers/app.js';

/**
 * Subtitle endpoints and manifest injection, driven through the API with packaged output
 * faked in storage: no FFmpeg or Redis needed, so these run everywhere.
 */

const MASTER = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_A1",NAME="audio_2",DEFAULT=YES,CHANNELS="2",URI="media_2.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=933120,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2",AUDIO="group_A1"
media_0.m3u8

#EXT-X-STREAM-INF:BANDWIDTH=2933120,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="group_A1"
media_1.m3u8
`;

const MPD = `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" mediaPresentationDuration="PT0H0M10.0S">
  <Period id="0" start="PT0.0S">
    <AdaptationSet id="0" contentType="video">
      <Representation id="0" mimeType="video/mp4" codecs="avc1.64001e" bandwidth="800000" width="640" height="360"></Representation>
    </AdaptationSet>
    <AdaptationSet id="1" contentType="audio">
      <Representation id="1" mimeType="audio/mp4" codecs="mp4a.40.2" bandwidth="128000"></Representation>
    </AdaptationSet>
  </Period>
</MPD>`;

const VTT = `WEBVTT

00:00:00.500 --> 00:00:02.000
Hello

00:00:02.500 --> 00:00:04.000
World
`;

interface SubtitleView {
  language: string;
  label: string;
  isDefault: boolean;
  cueCount: number;
  url: string;
  playlistUrl: string;
}

async function seedVideo(t: TestApp, id: string): Promise<void> {
  await t.app.db.videos.create({ id, status: 'uploaded' });
  await t.app.db.videos.update(id, {
    status: 'ready',
    durationSeconds: 10,
    width: 1280,
    height: 720,
    hlsManifestKey: `videos/${id}/master.m3u8`,
    dashManifestKey: `videos/${id}/master.mpd`,
  });
  await t.app.storage.put(`videos/${id}/master.m3u8`, MASTER);
  await t.app.storage.put(`videos/${id}/master.mpd`, MPD);
}

describe('subtitles feature', () => {
  describe('enabled', () => {
    let t: TestApp;
    let headers: Record<string, string>;
    const id = 'vid-subs';

    beforeAll(async () => {
      t = await createTestApp({ env: { FEATURE_SUBTITLES: 'true' } });
      headers = { 'x-api-key': t.apiKey };
      await seedVideo(t, id);
    });

    afterAll(async () => {
      await t.close();
    });

    const put = (language: string, body: string, query = '') =>
      t.app.inject({
        method: 'PUT',
        url: `/api/videos/${id}/subtitles/${language}${query}`,
        headers: { ...headers, 'content-type': 'text/vtt' },
        payload: body,
      });

    it('stores an uploaded track and lists it', async () => {
      const created = await put('en', VTT, '?label=English&default=true');
      expect(created.statusCode).toBe(201);
      expect(created.json<SubtitleView>()).toMatchObject({
        language: 'en',
        label: 'English',
        isDefault: true,
        cueCount: 2,
        url: `/api/videos/${id}/subtitles/en.vtt`,
        playlistUrl: `/api/videos/${id}/subtitles/en.m3u8`,
      });

      // The file itself is in storage and served back verbatim.
      const fetched = await t.app.inject({
        method: 'GET',
        url: `/api/videos/${id}/subtitles/en.vtt`,
        headers,
      });
      expect(fetched.statusCode).toBe(200);
      expect(fetched.headers['content-type']).toMatch(/text\/vtt/);
      expect(fetched.body).toBe(VTT);

      const list = await t.app.inject({
        method: 'GET',
        url: `/api/videos/${id}/subtitles`,
        headers,
      });
      expect(list.json<SubtitleView[]>()).toHaveLength(1);
    });

    it('replaces a track on a second upload and derives a label when none is given', async () => {
      const replaced = await put('en', `${VTT}\n00:00:05.000 --> 00:00:06.000\nAgain\n`);
      expect(replaced.statusCode).toBe(200);
      expect(replaced.json<SubtitleView>().cueCount).toBe(3);
      expect(replaced.json<SubtitleView>().label.length).toBeGreaterThan(0);
      expect((await t.app.db.subtitles.listForVideo(id)).length).toBe(1);
    });

    it('normalises the language tag and keeps one default', async () => {
      const created = await put('pt-br', VTT, '?default=true');
      expect(created.statusCode).toBe(201);
      expect(created.json<SubtitleView>().language).toBe('pt-BR');

      const tracks = await t.app.db.subtitles.listForVideo(id);
      expect(tracks.map((s) => s.language).sort()).toEqual(['en', 'pt-BR']);
      expect(tracks.filter((s) => s.isDefault).map((s) => s.language)).toEqual(['pt-BR']);
    });

    it('generates an HLS media playlist for each track', async () => {
      const res = await t.app.inject({
        method: 'GET',
        url: `/api/videos/${id}/subtitles/en.m3u8`,
        headers,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/mpegurl/);
      expect(res.body).toContain('#EXT-X-TARGETDURATION:10');
      expect(res.body).toContain('en.vtt');

      const missing = await t.app.inject({
        method: 'GET',
        url: `/api/videos/${id}/subtitles/de.m3u8`,
        headers,
      });
      expect(missing.statusCode).toBe(404);
    });

    it('weaves the tracks into the served HLS master and DASH manifest', async () => {
      const master = await t.app.inject({
        method: 'GET',
        url: `/api/videos/${id}/master.m3u8`,
        headers,
      });
      expect(master.statusCode).toBe(200);
      expect(master.headers['content-type']).toMatch(/mpegurl/);
      const parsed = parseHlsMaster(master.body);
      const subs = parsed.media.filter((m) => m.type === 'SUBTITLES');
      expect(subs.map((m) => m.uri).sort()).toEqual(['subtitles/en.m3u8', 'subtitles/pt-BR.m3u8']);
      expect(subs.filter((m) => m.isDefault).map((m) => m.name)).toHaveLength(1);
      expect(parsed.variants).toHaveLength(2);
      expect(master.body.match(/SUBTITLES="subs"/g)).toHaveLength(2);
      // The stored file is untouched; injection happens on the way out.
      expect(await t.app.storage.stat(`videos/${id}/master.m3u8`)).not.toBeNull();

      const mpd = await t.app.inject({
        method: 'GET',
        url: `/api/videos/${id}/master.mpd`,
        headers,
      });
      expect(mpd.statusCode).toBe(200);
      expect(mpd.headers['content-type']).toMatch(/dash\+xml/);
      expect(parseMpd(mpd.body).adaptationSets).toBe(4);
      expect(mpd.body).toContain('<BaseURL>subtitles/pt-BR.vtt</BaseURL>');
    });

    it('lists tracks on the video detail response', async () => {
      const res = await t.app.inject({ method: 'GET', url: `/api/videos/${id}`, headers });
      const body = res.json<{ subtitles: SubtitleView[]; thumbnails: unknown }>();
      expect(body.subtitles.map((s) => s.language).sort()).toEqual(['en', 'pt-BR']);
      expect(body.thumbnails).toBeNull();
    });

    it('rejects invalid WebVTT, bad language tags, and unknown videos', async () => {
      const notVtt = await put('de', 'just some text\n');
      expect(notVtt.statusCode).toBe(400);
      expect(notVtt.json<{ message: string }>().message).toMatch(/invalid WebVTT/);

      expect((await put('de', 'WEBVTT\n\nno cues here\n')).statusCode).toBe(400);
      expect((await put('de', '')).statusCode).toBe(400);
      expect((await put('not_a_language', VTT)).statusCode).toBe(400);

      const unknownVideo = await t.app.inject({
        method: 'PUT',
        url: '/api/videos/ghost/subtitles/en',
        headers: { ...headers, 'content-type': 'text/vtt' },
        payload: VTT,
      });
      expect(unknownVideo.statusCode).toBe(404);
      expect((await t.app.db.subtitles.listForVideo(id)).length).toBe(2);
    });

    it('requires the API key', async () => {
      const res = await t.app.inject({
        method: 'PUT',
        url: `/api/videos/${id}/subtitles/nl`,
        headers: { 'content-type': 'text/vtt' },
        payload: VTT,
      });
      expect(res.statusCode).toBe(401);
    });

    it('deletes a track, its file, and its manifest entries', async () => {
      const del = await t.app.inject({
        method: 'DELETE',
        url: `/api/videos/${id}/subtitles/pt-BR`,
        headers,
      });
      expect(del.statusCode).toBe(204);
      expect(await t.app.storage.exists(`videos/${id}/subtitles/pt-BR.vtt`)).toBe(false);
      expect(await t.app.db.subtitles.get(id, 'pt-BR')).toBeNull();

      const master = await t.app.inject({
        method: 'GET',
        url: `/api/videos/${id}/master.m3u8`,
        headers,
      });
      expect(master.body).not.toContain('pt-BR');
      expect(master.body).toContain('subtitles/en.m3u8');

      const again = await t.app.inject({
        method: 'DELETE',
        url: `/api/videos/${id}/subtitles/pt-BR`,
        headers,
      });
      expect(again.statusCode).toBe(404);
    });
  });

  describe('disabled (the default)', () => {
    let t: TestApp;
    let headers: Record<string, string>;
    const id = 'vid-nosubs';

    beforeAll(async () => {
      t = await createTestApp();
      headers = { 'x-api-key': t.apiKey };
      await seedVideo(t, id);
    });

    afterAll(async () => {
      await t.close();
    });

    it('refuses uploads with an explanatory 404', async () => {
      const res = await t.app.inject({
        method: 'PUT',
        url: `/api/videos/${id}/subtitles/en`,
        headers: { ...headers, 'content-type': 'text/vtt' },
        payload: VTT,
      });
      expect(res.statusCode).toBe(404);
      expect(res.json<{ message: string }>().message).toMatch(/FEATURE_SUBTITLES/);
      expect(await t.app.db.subtitles.listForVideo(id)).toEqual([]);
    });

    it('hides any existing tracks from the API and the manifests', async () => {
      // A track recorded while the feature was on (simulated directly against the database).
      await t.app.storage.put(`videos/${id}/subtitles/en.vtt`, VTT);
      await t.app.db.subtitles.upsert({
        videoId: id,
        language: 'en',
        label: 'English',
        storageKey: `videos/${id}/subtitles/en.vtt`,
        cueCount: 2,
        sizeBytes: VTT.length,
      });

      const list = await t.app.inject({
        method: 'GET',
        url: `/api/videos/${id}/subtitles`,
        headers,
      });
      expect(list.json()).toEqual([]);

      const detail = await t.app.inject({ method: 'GET', url: `/api/videos/${id}`, headers });
      expect(detail.json<{ subtitles: unknown[] }>().subtitles).toEqual([]);

      const master = await t.app.inject({
        method: 'GET',
        url: `/api/videos/${id}/master.m3u8`,
        headers,
      });
      expect(master.body).not.toContain('SUBTITLES');
      expect(master.body).toBe(MASTER);

      const mpd = await t.app.inject({
        method: 'GET',
        url: `/api/videos/${id}/master.mpd`,
        headers,
      });
      expect(parseMpd(mpd.body).adaptationSets).toBe(2);

      // The playlist route is gated too, though the raw file stays fetchable.
      expect(
        (await t.app.inject({ method: 'GET', url: `/api/videos/${id}/subtitles/en.m3u8`, headers }))
          .statusCode,
      ).toBe(404);
      expect(
        (await t.app.inject({ method: 'GET', url: `/api/videos/${id}/subtitles/en.vtt`, headers }))
          .statusCode,
      ).toBe(200);
    });
  });
});
