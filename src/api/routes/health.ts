import type { FastifyInstance } from 'fastify';

type CheckResult = 'ok' | 'error';

const healthResponseSchema = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['ok', 'degraded'] },
    checks: {
      type: 'object',
      properties: {
        db: { type: 'string', enum: ['ok', 'error'] },
        redis: { type: 'string', enum: ['ok', 'error'] },
      },
      required: ['db', 'redis'],
    },
    uptimeSeconds: { type: 'integer' },
    timestamp: { type: 'string' },
  },
  required: ['status', 'checks', 'uptimeSeconds', 'timestamp'],
} as const;

/**
 * GET /healthz - liveness plus a database and Redis round-trip. Intentionally unauthenticated
 * (CLAUDE.md: "All endpoints except /healthz require an X-API-Key header"). Returns 503 with
 * status `degraded` when any dependency check fails.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/healthz',
    {
      config: { public: true },
      schema: { response: { 200: healthResponseSchema, 503: healthResponseSchema } },
    },
    async (_request, reply) => {
      const check = async (name: string, probe: () => Promise<void>): Promise<CheckResult> => {
        try {
          await probe();
          return 'ok';
        } catch (err) {
          app.log.error({ err, check: name }, 'healthz: dependency check failed');
          return 'error';
        }
      };

      const [db, redis] = await Promise.all([
        check('db', () => app.db.ping()),
        check('redis', () => app.queue.ping()),
      ]);
      const healthy = db === 'ok' && redis === 'ok';

      return reply.code(healthy ? 200 : 503).send({
        status: healthy ? 'ok' : 'degraded',
        checks: { db, redis },
        uptimeSeconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
      });
    },
  );
}
