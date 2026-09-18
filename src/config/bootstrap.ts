import { ConfigError, loadConfig, type AppConfig } from './env.js';

/** Load `.env` from the working directory if present; existing process.env values win. */
export function loadDotEnvFile(file = '.env'): void {
  try {
    process.loadEnvFile(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Process entrypoints (API server, worker) call this once: load `.env`, validate, and exit with
 * a readable list of problems if the environment is misconfigured.
 */
export function bootstrapConfig(): AppConfig {
  loadDotEnvFile();
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
}
