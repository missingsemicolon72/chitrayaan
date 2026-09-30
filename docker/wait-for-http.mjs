/**
 * Wait until each URL answers, then run the given command.
 *
 * Compose's `depends_on: service_healthy` covers containers whose images ship a healthcheck
 * tool. The S3 server's does not, so the API and worker poll it themselves with Node's own
 * fetch, which needs nothing installed in the other image.
 *
 * Usage: node docker/wait-for-http.mjs <url>... -- <command> [args...]
 */
import { spawn } from 'node:child_process';

const separator = process.argv.indexOf('--');
if (separator === -1) {
  console.error('usage: wait-for-http.mjs <url>... -- <command> [args...]');
  process.exit(2);
}
const urls = process.argv.slice(2, separator);
const [command, ...args] = process.argv.slice(separator + 1);
if (!command) {
  console.error('wait-for-http: no command given');
  process.exit(2);
}

const TIMEOUT_MS = Number(process.env.WAIT_FOR_TIMEOUT_MS ?? 120_000);
const INTERVAL_MS = 1_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Any HTTP answer means the service is listening; the status itself does not matter. */
async function answers(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
}

for (const url of urls) {
  const deadline = Date.now() + TIMEOUT_MS;
  let reported = false;
  while (!(await answers(url))) {
    if (Date.now() > deadline) {
      console.error(`wait-for-http: ${url} did not answer within ${TIMEOUT_MS}ms`);
      process.exit(1);
    }
    if (!reported) {
      console.log(`wait-for-http: waiting for ${url}`);
      reported = true;
    }
    await sleep(INTERVAL_MS);
  }
  console.log(`wait-for-http: ${url} is up`);
}

// Replace this process's role with the real command, passing signals through so that
// `docker compose stop` still shuts the app down gracefully.
const child = spawn(command, args, { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
