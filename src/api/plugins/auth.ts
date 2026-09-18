import { timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Set `public: true` in a route's `config` to skip API-key auth. Only `/healthz` should. */
    public?: boolean;
  }
}

export const API_KEY_HEADER = 'x-api-key';

export interface ApiKeyAuthOptions {
  /**
   * URL prefixes served without a key. Used for static assets (the test player page) whose
   * routes are registered by a plugin and cannot carry `config.public`. A browser navigating to
   * a page cannot send custom headers, and the assets themselves contain no data.
   */
  publicPrefixes?: readonly string[];
}

function keysMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Decision #12: a single shared API key, sent as `X-API-Key`, guards every route except those
 * marked `config.public` or under a public prefix. Registered at the root so it also covers
 * unknown routes (401, not 404, so route existence is not revealed) and every plugin registered
 * afterwards.
 *
 * `OPTIONS` is exempt: browser CORS preflights cannot carry custom headers, and a preflight
 * response reveals nothing.
 */
export function registerApiKeyAuth(
  app: FastifyInstance,
  apiKey: string,
  options: ApiKeyAuthOptions = {},
): void {
  const publicPrefixes = options.publicPrefixes ?? [];
  const isPublicPath = (url: string) => {
    const pathOnly = url.split('?')[0] ?? url;
    return publicPrefixes.some((p) => pathOnly === p || pathOnly.startsWith(`${p}/`));
  };

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.method === 'OPTIONS') return;
    if (request.routeOptions.config.public === true) return;
    if (isPublicPath(request.url)) return;

    const header = request.headers[API_KEY_HEADER];
    const provided = Array.isArray(header) ? header[0] : header;
    if (typeof provided !== 'string' || !keysMatch(provided, apiKey)) {
      return reply.code(401).send({
        statusCode: 401,
        error: 'Unauthorized',
        message: `missing or invalid ${API_KEY_HEADER} header`,
      });
    }
  });
}
