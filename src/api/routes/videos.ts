import type { FastifyInstance } from 'fastify';

import { VIDEO_STATUSES, type VideoStatus } from '../../lib/db/index.js';
import { assertValidKey, contentTypeForKey } from '../../lib/storage/index.js';

interface VideoListQuery {
  limit?: number;
  offset?: number;
  status?: VideoStatus;
}

const notFound = (message: string) => ({ statusCode: 404, error: 'Not Found', message });

/** Video records plus the files under `videos/<id>/` (rendition playlists and segments). */
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
    {
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', minLength: 1 } },
          required: ['id'],
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const video = await app.db.videos.get(id);
      if (!video) return reply.code(404).send(notFound(`video ${id} not found`));
      const [jobs, renditions] = await Promise.all([
        app.db.jobs.list({ videoId: id, limit: 200 }),
        app.db.renditions.listForVideo(id),
      ]);
      return {
        ...video,
        jobs: jobs.items,
        renditions: renditions.map((r) => ({
          ...r,
          playlistUrl: `/api/videos/${id}/${r.playlistKey.slice(`videos/${id}/`.length)}`,
        })),
      };
    },
  );

  /**
   * Serve any stored object under `videos/<id>/`: rendition playlists, init segments, media
   * segments (and, from Milestone 6, the master manifests). Streams straight from storage.
   */
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
    async (request, reply) => {
      const { id } = request.params;
      const key = `videos/${id}/${request.params['*']}`;
      try {
        assertValidKey(key);
      } catch {
        return reply.code(404).send(notFound('no such file'));
      }
      const info = await app.storage.stat(key);
      if (!info) return reply.code(404).send(notFound('no such file'));
      return reply
        .type(contentTypeForKey(key))
        .header('content-length', String(info.size))
        .header('last-modified', info.lastModified.toUTCString())
        .send(await app.storage.get(key));
    },
  );
}
