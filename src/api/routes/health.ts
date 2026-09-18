import type { FastifyInstance } from 'fastify';

const healthResponseSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ok', 'degraded'] },
    checks: {
      type: 'object',
      properties: { db: { type: 'string', enum: ['ok', 'error'] } },
      required: ['db'],
    },
    uptimeSeconds: { type: 'integer' },
    timestamp: { type: 'string' },
  },
  required: ['status', 'checks', 'uptimeSeconds', 'timestamp'],
} as const;

/**
 * GET /healthz - liveness + a database round-trip. Intentionally unauthenticated (CLAUDE.md:
 * "All endpoints except /healthz require an X-API-Key header"). Returns 503 when the DB is down.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/healthz',
    { schema: { response: { 200: healthResponseSchema, 503: healthResponseSchema } } },
    async (_request, reply) => {
      let db: 'ok' | 'error' = 'ok';
      try {
        await app.db.ping();
      } catch (err) {
        app.log.error(err, 'healthz: database ping failed');
        db = 'error';
      }

      return reply.code(db === 'ok' ? 200 : 503).send({
        status: db === 'ok' ? 'ok' : 'degraded',
        checks: { db },
        uptimeSeconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
      });
    },
  );
}
