import type { FastifyInstance } from 'fastify';

import { VIDEO_STATUSES, type VideoStatus } from '../../lib/db/index.js';
import { SUBTITLES_PREFIX } from '../../lib/features/subtitles/index.js';
import {
  DASH_MANIFEST,
  HLS_MASTER,
  injectDashSubtitles,
  injectHlsSubtitles,
  type SubtitleTrackRef,
} from '../../lib/packaging/index.js';
import { notFound, readStoredText, sendStoredObject } from '../serve.js';
import { toSubtitleView } from './subtitles.js';

interface VideoListQuery {
  limit?: number;
  offset?: number;
  status?: VideoStatus;
}

const idSchema = {
  type: 'object',
  properties: { id: { type: 'string', minLength: 1 } },
  required: ['id'],
} as const;

/**
 * Subtitle tracks as manifest references. Returns nothing while `FEATURE_SUBTITLES` is off, so
 * turning the flag off hides existing tracks from players without deleting them.
 */
async function subtitleTracks(app: FastifyInstance, videoId: string): Promise<SubtitleTrackRef[]> {
  if (!app.config.FEATURE_SUBTITLES) return [];
  const tracks = await app.db.subtitles.listForVideo(videoId);
  return tracks.map((track) => ({
    language: track.language,
    label: track.label,
    isDefault: track.isDefault,
    hlsPlaylistUri: `${SUBTITLES_PREFIX}/${track.language}.m3u8`,
    vttUri: `${SUBTITLES_PREFIX}/${track.language}.vtt`,
  }));
}

/** Video records plus the files under `videos/<id>/` (manifests, playlists, segments, sprites). */
export async function videoRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: VideoListQuery }>(
    '/api/videos',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 200 },
            offset: { type: 'integer', minimum: 0 },
            status: { type: 'string', enum: [...VIDEO_STATUSES] },
          },
        },
      },
    },
    async (request) => app.db.videos.list(request.query),
  );

  app.get<{ Params: { id: string } }>(
    '/api/videos/:id',
    { schema: { params: idSchema } },
    async (request, reply) => {
      const { id } = request.params;
      const video = await app.db.videos.get(id);
      if (!video) return reply.code(404).send(notFound(`video ${id} not found`));

      const [jobs, renditions, subtitles] = await Promise.all([
        app.db.jobs.list({ videoId: id, limit: 200 }),
        app.db.renditions.listForVideo(id),
        app.config.FEATURE_SUBTITLES ? app.db.subtitles.listForVideo(id) : Promise.resolve([]),
      ]);
      const urlFor = (key: string | null) =>
        key === null ? null : `/api/videos/${id}/${key.slice(`videos/${id}/`.length)}`;

      return {
        ...video,
        jobs: jobs.items,
        manifests: { hls: urlFor(video.hlsManifestKey), dash: urlFor(video.dashManifestKey) },
        renditions: renditions.map((r) => ({ ...r, playlistUrl: urlFor(r.playlistKey) })),
        subtitles: subtitles.map(toSubtitleView),
        thumbnails:
          app.config.FEATURE_THUMBNAILS && video.thumbnailTrackKey
            ? {
                trackUrl: urlFor(video.thumbnailTrackKey),
                spriteCount: video.thumbnailSpriteCount ?? 0,
              }
            : null,
      };
    },
  );

  /**
   * The master manifests are served rather than copied: the packaged file is read from storage
   * and any subtitle tracks are woven in on the way out, so uploading a track takes effect
   * without re-transcoding.
   */
  app.get<{ Params: { id: string } }>(
    `/api/videos/:id/${HLS_MASTER}`,
    { schema: { params: idSchema } },
    async (request, reply) => {
      const { id } = request.params;
      const master = await readStoredText(app.storage, `videos/${id}/${HLS_MASTER}`);
      if (master === null) return reply.code(404).send(notFound('no such file'));
      return reply
        .type('application/vnd.apple.mpegurl')
        .send(injectHlsSubtitles(master, await subtitleTracks(app, id)));
    },
  );

  app.get<{ Params: { id: string } }>(
    `/api/videos/:id/${DASH_MANIFEST}`,
    { schema: { params: idSchema } },
    async (request, reply) => {
      const { id } = request.params;
      const mpd = await readStoredText(app.storage, `videos/${id}/${DASH_MANIFEST}`);
      if (mpd === null) return reply.code(404).send(notFound('no such file'));
      return reply
        .type('application/dash+xml')
        .send(injectDashSubtitles(mpd, await subtitleTracks(app, id)));
    },
  );

  /** Everything else under the video: media playlists, init and media segments, sprites. */
  app.get<{ Params: { id: string; '*': string } }>(
    '/api/videos/:id/*',
    {
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', minLength: 1 }, '*': { type: 'string' } },
          required: ['id', '*'],
        },
      },
    },
    async (request, reply) =>
      sendStoredObject(app, reply, `videos/${request.params.id}/${request.params['*']}`),
  );
}
