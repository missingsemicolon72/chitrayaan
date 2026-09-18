import type { FastifyInstance } from 'fastify';

import { JOB_STATUSES, type JobStatus } from '../../lib/db/index.js';

interface JobListQuery {
  videoId?: string;
  status?: JobStatus;
  limit?: number;
  offset?: number;
}

/**
 * Job status API. The database record is the source of truth (the worker keeps it current);
 * `queue` adds BullMQ's live view when Redis is reachable, and is null otherwise.
 */
export async function jobRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: JobListQuery }>(
    '/api/jobs',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            videoId: { type: 'string', minLength: 1 },
            status: { type: 'string', enum: [...JOB_STATUSES] },
            limit: { type: 'integer', minimum: 1, maximum: 200 },
            offset: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
    async (request) => app.db.jobs.list(request.query),
  );

  app.get<{ Params: { id: string } }>(
    '/api/jobs/:id',
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
      const job = await app.db.jobs.get(id);
      if (!job) {
        return reply
          .code(404)
          .send({ statusCode: 404, error: 'Not Found', message: `job ${id} not found` });
      }
      let queue = null;
      try {
        queue = await app.queue.getState(id);
      } catch (err) {
        app.log.warn({ err, jobId: id }, 'queue state unavailable');
      }
      return { ...job, queue };
    },
  );
}
