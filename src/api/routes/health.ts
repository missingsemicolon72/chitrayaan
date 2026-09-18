import type { FastifyInstance } from 'fastify';

/**
 * GET /healthz - liveness probe. Intentionally unauthenticated (CLAUDE.md: "All endpoints except
 * /healthz require an X-API-Key header"). Later milestones may add dependency checks (Redis, DB).
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/healthz',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['ok'] },
              uptimeSeconds: { type: 'integer' },
              timestamp: { type: 'string' },
            },
            required: ['status', 'uptimeSeconds', 'timestamp'],
          },
        },
      },
    },
    async () => ({
      status: 'ok' as const,
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    }),
  );
}
