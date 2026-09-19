import type { FastifyInstance } from 'fastify';

import { reconcileQueuedJobs } from '../lib/queue/reconcile.js';

/** How often the API runs its background housekeeping. */
export const MAINTENANCE_INTERVAL_MS = 15 * 60_000;

/**
 * Periodic housekeeping, also run once at startup:
 *  - hand the queue any job that never reached Redis (an outage while an upload finished);
 *  - delete abandoned resumable uploads and their placeholder records.
 *
 * Each step is isolated: one failing must not stop the other, and neither may take the API down.
 */
export async function runMaintenance(app: FastifyInstance): Promise<void> {
  try {
    const enqueued = await reconcileQueuedJobs(app.db, app.queue, app.log);
    if (enqueued > 0) app.log.info({ count: enqueued }, 'reconciled pending jobs into queue');
  } catch (err) {
    app.log.warn({ err }, 'job reconciliation failed; will try again later');
  }

  try {
    await app.sweepExpiredUploads();
  } catch (err) {
    app.log.warn({ err }, 'upload sweep failed; will try again later');
  }
}

/** Start the maintenance timer and stop it when the app closes. Never overlaps two runs. */
export function startMaintenance(app: FastifyInstance): void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void runMaintenance(app).finally(() => {
      running = false;
    });
  }, MAINTENANCE_INTERVAL_MS);
  // Housekeeping must not keep the process alive on its own.
  timer.unref();
  app.addHook('onClose', () => {
    clearInterval(timer);
  });
}
