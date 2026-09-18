import { bootstrapConfig } from '../config/index.js';
import { buildApp } from './app.js';

const config = bootstrapConfig();
const app = await buildApp(config);

const shutdown = (signal: NodeJS.Signals) => {
  app.log.info({ signal }, 'shutting down');
  app
    .close()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      app.log.error(err, 'error during shutdown');
      process.exit(1);
    });
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

try {
  await app.listen({ port: config.PORT, host: config.HOST });
} catch (err) {
  app.log.error(err, 'failed to start server');
  process.exit(1);
}
