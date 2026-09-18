import { ConfigError, loadConfig } from '../config/index.js';
import { buildApp } from './app.js';

/** Load `.env` from the working directory if present; existing process.env values win. */
function loadDotEnv(): void {
  try {
    process.loadEnvFile('.env');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

loadDotEnv();

let config;
try {
  config = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}

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
