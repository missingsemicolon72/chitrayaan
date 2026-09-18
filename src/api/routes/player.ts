import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

export const PLAYER_PREFIX = '/player';

const require = createRequire(import.meta.url);

/** `<repo>/player`, resolved relative to this file so it works from `src/` (tsx) and `dist/`. */
export function playerRootDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'player');
}

/**
 * Directory of an installed package. `require.resolve('<pkg>/dist/...')` is blocked by
 * packages that restrict `exports` (dash.js does), so walk up from the package's main entry.
 */
export function packageRootDir(name: string): string {
  let dir = path.dirname(require.resolve(name));
  while (path.basename(dir) !== name) {
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`could not locate package root for ${name}`);
    dir = parent;
  }
  return dir;
}

/**
 * The manual test player (Milestone 7): a plain HTML page using hls.js and dash.js, served by
 * the API itself so playback requests are same-origin and need no CORS. The page and the
 * vendored player libraries are public (see `publicPrefixes` in the auth plugin); every
 * manifest and segment request the page makes still carries the API key.
 */
export async function playerRoutes(app: FastifyInstance): Promise<void> {
  await app.register(fastifyStatic, {
    root: playerRootDir(),
    prefix: `${PLAYER_PREFIX}/`,
    index: ['index.html'],
    // The API sets its own cache policy for media; keep the page itself uncached during dev.
    cacheControl: false,
  });

  // Player libraries straight from node_modules, pinned by package-lock. Both are the UMD
  // builds (they define `Hls` / `dashjs` globals for a plain <script> tag).
  const vendors = [
    ['hls', path.join(packageRootDir('hls.js'), 'dist')],
    ['dash', path.join(packageRootDir('dashjs'), 'dist', 'legacy', 'umd')],
  ] as const;
  for (const [name, root] of vendors) {
    await app.register(fastifyStatic, {
      root,
      prefix: `${PLAYER_PREFIX}/vendor/${name}/`,
      decorateReply: false,
      cacheControl: false,
    });
  }
}
