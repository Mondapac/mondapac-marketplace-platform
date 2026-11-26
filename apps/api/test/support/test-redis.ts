import { randomBytes } from 'node:crypto';

/**
 * The Redis of the tests that count in Redis (ADR-0054): `REDIS_URL`, the local Compose service
 * otherwise. CI runs a Redis service in every job that boots the API (`.github/workflows/ci.yml`).
 */
export function testRedisUrl(): string {
  return process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
}

/** The environment that makes a test application count the Redis classes in Redis. */
export function testRedisEnv(): Record<string, string> {
  return { REDIS_URL: testRedisUrl(), RATE_LIMIT_STORE: 'redis' };
}

/**
 * A key prefix of this Jest worker and a random part, so parallel suites and repeated runs never
 * share a window (Kazem on the design). Under `rl:`, so the rate-limit ACL user can reach it.
 */
export function testRedisKeyPrefix(): string {
  return `rl:test-${process.env.JEST_WORKER_ID ?? '0'}-${randomBytes(4).toString('hex')}`;
}
