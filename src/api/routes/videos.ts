import type { FastifyInstance } from 'fastify';

import { VIDEO_STATUSES, type VideoStatus } from '../../lib/db/index.js';

interface VideoListQuery {
  limit?: number;
  offset?: number;
  status?: VideoStatus;
}

/** Read-only views of video records. Playback routes (`master.m3u8` etc.) arrive in Milestone 6. */
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
      if (!video) {
        return reply
          .code(404)
          .send({ statusCode: 404, error: 'Not Found', message: `video ${id} not found` });
      }
      const jobs = await app.db.jobs.list({ videoId: id, limit: 200 });
      return { ...video, jobs: jobs.items };
    },
  );
}
