import type { FastifyInstance } from 'fastify';

import type { Subtitle } from '../../lib/db/index.js';
import {
  assertSubtitleSize,
  buildSubtitlePlaylist,
  defaultLabel,
  InvalidLanguageError,
  InvalidWebVttError,
  normalizeLanguage,
  parseWebVtt,
  subtitleKey,
  SUBTITLE_MAX_BYTES,
  SUBTITLES_PREFIX,
} from '../../lib/features/subtitles/index.js';
import { notFound, sendStoredObject } from '../serve.js';

interface SubtitleParams {
  id: string;
  language: string;
}

interface SubtitleQuery {
  label?: string;
  default?: boolean;
}

export interface SubtitleView {
  videoId: string;
  language: string;
  label: string;
  isDefault: boolean;
  cueCount: number;
  sizeBytes: number;
  /** The WebVTT file. */
  url: string;
  /** The generated HLS media playlist that wraps it. */
  playlistUrl: string;
  createdAt: string;
  updatedAt: string;
}

export function toSubtitleView(subtitle: Subtitle): SubtitleView {
  const base = `/api/videos/${subtitle.videoId}/${SUBTITLES_PREFIX}/${subtitle.language}`;
  return {
    videoId: subtitle.videoId,
    language: subtitle.language,
    label: subtitle.label,
    isDefault: subtitle.isDefault,
    cueCount: subtitle.cueCount,
    sizeBytes: subtitle.sizeBytes,
    url: `${base}.vtt`,
    playlistUrl: `${base}.m3u8`,
    createdAt: subtitle.createdAt,
    updatedAt: subtitle.updatedAt,
  };
}

const featureDisabled = notFound(
  'the subtitles feature is disabled (set FEATURE_SUBTITLES=true to enable it)',
);

const badRequest = (message: string) => ({ statusCode: 400, error: 'Bad Request', message });

/**
 * Manually uploaded WebVTT subtitle tracks (decision #13, gated by `FEATURE_SUBTITLES`).
 * Tracks live beside the packaged output at `videos/<id>/subtitles/<lang>.vtt` and survive a
 * re-transcode; they are woven into the HLS and DASH manifests when those are served.
 */
export async function subtitleRoutes(app: FastifyInstance): Promise<void> {
  const enabled = app.config.FEATURE_SUBTITLES;

  app.addContentTypeParser(
    ['text/vtt', 'text/plain'],
    { parseAs: 'string', bodyLimit: SUBTITLE_MAX_BYTES },
    (_request, body, done) => {
      done(null, body);
    },
  );

  const idSchema = {
    type: 'object',
    properties: { id: { type: 'string', minLength: 1 } },
    required: ['id'],
  } as const;

  const trackSchema = {
    type: 'object',
    properties: {
      id: { type: 'string', minLength: 1 },
      language: { type: 'string', minLength: 1, maxLength: 35 },
    },
    required: ['id', 'language'],
  } as const;

  app.get<{ Params: { id: string } }>(
    '/api/videos/:id/subtitles',
    { schema: { params: idSchema } },
    async (request, reply) => {
      const video = await app.db.videos.get(request.params.id);
      if (!video) return reply.code(404).send(notFound(`video ${request.params.id} not found`));
      if (!enabled) return [];
      const tracks = await app.db.subtitles.listForVideo(video.id);
      return tracks.map(toSubtitleView);
    },
  );

  app.put<{ Params: SubtitleParams; Querystring: SubtitleQuery; Body: string }>(
    '/api/videos/:id/subtitles/:language',
    {
      bodyLimit: SUBTITLE_MAX_BYTES,
      schema: {
        params: trackSchema,
        querystring: {
          type: 'object',
          properties: {
            label: { type: 'string', minLength: 1, maxLength: 120 },
            default: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      if (!enabled) return reply.code(404).send(featureDisabled);

      const video = await app.db.videos.get(request.params.id);
      if (!video) return reply.code(404).send(notFound(`video ${request.params.id} not found`));

      let language: string;
      try {
        language = normalizeLanguage(request.params.language);
      } catch (err) {
        if (err instanceof InvalidLanguageError)
          return reply.code(400).send(badRequest(err.message));
        throw err;
      }

      const body = typeof request.body === 'string' ? request.body : '';
      const sizeBytes = Buffer.byteLength(body, 'utf8');
      let cueCount: number;
      try {
        assertSubtitleSize(sizeBytes);
        cueCount = parseWebVtt(body).cueCount;
      } catch (err) {
        if (err instanceof InvalidWebVttError) {
          return reply.code(400).send(badRequest(`invalid WebVTT: ${err.message}`));
        }
        throw err;
      }

      const storageKey = subtitleKey(video.id, language);
      await app.storage.put(storageKey, body, { contentType: 'text/vtt' });
      const existed = (await app.db.subtitles.get(video.id, language)) !== null;
      const saved = await app.db.subtitles.upsert({
        videoId: video.id,
        language,
        label: request.query.label ?? defaultLabel(language),
        storageKey,
        isDefault: request.query.default === true,
        cueCount,
        sizeBytes,
      });
      app.log.info({ videoId: video.id, language, cueCount, sizeBytes }, 'subtitle track stored');
      return reply.code(existed ? 200 : 201).send(toSubtitleView(saved));
    },
  );

  app.delete<{ Params: SubtitleParams }>(
    '/api/videos/:id/subtitles/:language',
    { schema: { params: trackSchema } },
    async (request, reply) => {
      if (!enabled) return reply.code(404).send(featureDisabled);
      let language: string;
      try {
        language = normalizeLanguage(request.params.language);
      } catch (err) {
        if (err instanceof InvalidLanguageError)
          return reply.code(400).send(badRequest(err.message));
        throw err;
      }
      const existing = await app.db.subtitles.get(request.params.id, language);
      if (!existing) {
        return reply
          .code(404)
          .send(notFound(`video ${request.params.id} has no ${language} subtitle track`));
      }
      await app.storage.delete(existing.storageKey);
      await app.db.subtitles.delete(request.params.id, language);
      app.log.info({ videoId: request.params.id, language }, 'subtitle track deleted');
      return reply.code(204).send();
    },
  );

  /**
   * Serve a track's files: the stored `.vtt`, and the `.m3u8` media playlist that HLS needs,
   * which is generated on request so it always matches the video's duration.
   */
  app.get<{ Params: { id: string; file: string } }>(
    '/api/videos/:id/subtitles/:file',
    {
      schema: {
        params: {
          type: 'object',
          properties: {
            id: { type: 'string', minLength: 1 },
            file: { type: 'string', minLength: 1, maxLength: 60 },
          },
          required: ['id', 'file'],
        },
      },
    },
    async (request, reply) => {
      const { id, file } = request.params;
      if (!file.endsWith('.m3u8')) {
        return sendStoredObject(app, reply, `videos/${id}/${SUBTITLES_PREFIX}/${file}`);
      }
      if (!enabled) return reply.code(404).send(featureDisabled);

      let language: string;
      try {
        language = normalizeLanguage(file.slice(0, -'.m3u8'.length));
      } catch {
        return reply.code(404).send(notFound('no such subtitle track'));
      }
      const [video, track] = await Promise.all([
        app.db.videos.get(id),
        app.db.subtitles.get(id, language),
      ]);
      if (!video || !track) return reply.code(404).send(notFound('no such subtitle track'));
      return reply
        .type('application/vnd.apple.mpegurl')
        .send(buildSubtitlePlaylist(language, video.durationSeconds ?? 0));
    },
  );
}
