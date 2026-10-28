/**
 * The suites that need FFmpeg, Redis, Postgres or S3 skip themselves when it is missing, so the
 * rest of the suite stays green on a machine without them. CI sets TEST_REQUIRE_SERVICES=1,
 * which turns a missing service into a failure instead: a service that did not come up must not
 * pass as a green build with its suites quietly skipped.
 */
export function unavailable(problem: string, skipped: string): false {
  if (process.env.TEST_REQUIRE_SERVICES === '1') {
    throw new Error(`[tests] ${problem}, and TEST_REQUIRE_SERVICES=1 forbids skipping ${skipped}`);
  }
  console.warn(`[tests] ${problem}; skipping ${skipped}`);
  return false;
}
