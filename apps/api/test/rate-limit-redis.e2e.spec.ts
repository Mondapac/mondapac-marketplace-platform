import { randomBytes } from 'node:crypto';
import { Controller, Get } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { Redis } from 'ioredis';
import request from 'supertest';
import { RoutePopulation } from '../src/platform/call-context/route-population.decorator';
import { RateLimitRedis } from '../src/platform/rate-limit/rate-limit-redis';
import {
  BREAKER_FAILURES_TO_OPEN,
  BREAKER_OPEN_MS,
  RedisRateLimitCounters,
} from '../src/platform/rate-limit/redis-rate-limit-counters';
import { createTestApp } from './support/test-app';
import { testRedisKeyPrefix, testRedisUrl } from './support/test-redis';

// ADR-0054 on a real Redis (CI: the Redis service of the job; locally: `docker compose up -d
// redis`). Each test uses a key prefix of its own, removed afterwards.

/** Hassan's ACL of the rate-limit user (design section 5), as R3 will create it. */
const RATE_LIMIT_ACL = [
  'on',
  'resetkeys',
  '~rl:*',
  '-@all',
  '+evalsha',
  '+eval',
  '+set',
  '+incrby',
  '+pttl',
  '+expire',
  '+get',
  '+del',
  '+multi',
  '+exec',
  '+ping',
  '+info',
] as const;

const KEY = 'b'.repeat(64);

@RoutePopulation('customer')
@Controller('test/redis-limited')
class RedisLimitedController {
  @Get('plain')
  plain(): { ok: true } {
    return { ok: true };
  }
}

function connectionOf(url: string, user?: { username: string; password: string }) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parsed.port === '' ? 6379 : Number(parsed.port),
    db: 0,
    tls: parsed.protocol === 'rediss:',
    username: user?.username ?? null,
    password: user?.password ?? null,
  };
}

describe('rate-limit counters on Redis (ADR-0054)', () => {
  let admin: Redis;
  let prefix: string;
  const opened: RateLimitRedis[] = [];

  const counters = (clock = new FixedClock(Temporal.Instant.from('2026-11-26T10:00:00Z'))) => {
    const redis = new RateLimitRedis(connectionOf(testRedisUrl()));
    opened.push(redis);
    return { counters: new RedisRateLimitCounters(redis, clock, prefix), clock };
  };

  const keysUnder = async (match: string): Promise<string[]> => {
    const found: string[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await admin.scan(cursor, 'MATCH', match, 'COUNT', 1000);
      cursor = next;
      found.push(...keys);
    } while (cursor !== '0');
    return found;
  };

  beforeAll(() => {
    admin = new Redis(testRedisUrl(), { lazyConnect: false, maxRetriesPerRequest: 1 });
  });

  beforeEach(() => {
    prefix = testRedisKeyPrefix();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await Promise.all(opened.splice(0).map((redis) => redis.onModuleDestroy()));
    const keys = await keysUnder(`${prefix}:*`);
    if (keys.length > 0) await admin.del(...keys);
  });

  afterAll(async () => {
    await admin.quit();
  });

  it('counts 100 parallel requests of one origin on two instances exactly, without a rejection', async () => {
    const first = counters().counters;
    const second = counters().counters;

    const counted = await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        (index % 2 === 0 ? first : second).consume('default', KEY),
      ),
    );

    expect(counted.map(({ count }) => count).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 1),
    );
    for (const { msBeforeNext } of counted) {
      expect(msBeforeNext).toBeGreaterThan(0);
      expect(msBeforeNext).toBeLessThanOrEqual(60_000);
    }
    expect(first.stats().fallbackRequests + second.stats().fallbackRequests).toBe(0);
    // One key, expiring with the window: nothing to purge.
    expect(await keysUnder(`${prefix}:*`)).toEqual([`${prefix}:default:${KEY}`]);
    expect(await admin.pttl(`${prefix}:default:${KEY}`)).toBeGreaterThan(0);
  });

  it('answers the Market limit on two API instances, then 429, never 503; the key holds no address', async () => {
    const shared = testRedisKeyPrefix();
    prefix = shared;
    const apps: NestExpressApplication[] = [];
    try {
      for (let index = 0; index < 2; index += 1) {
        const { app } = await createTestApp({
          controllers: [RedisLimitedController],
          rateLimitStore: 'redis',
          redisKeyPrefix: shared,
        });
        // Listening, so the parallel requests share one server instead of opening one each.
        await app.listen(0, '127.0.0.1');
        apps.push(app);
      }
      const statuses: number[] = [];
      // AU's default class allows 300 a minute: 310 requests, in parallel batches of 31.
      for (let batch = 0; batch < 10; batch += 1) {
        const answers = await Promise.all(
          Array.from({ length: 31 }, (_, index) =>
            request(apps[index % 2]!.getHttpServer())
              .get('/test/redis-limited/plain')
              .set('x-market-id', 'AU'),
          ),
        );
        statuses.push(...answers.map((answer) => answer.status));
      }

      expect(statuses.filter((status) => status === 200)).toHaveLength(300);
      expect(statuses.filter((status) => status === 429)).toHaveLength(10);
      expect(statuses).not.toContain(503);

      const keys = await keysUnder(`${shared}:*`);
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatch(new RegExp(`^${shared}:default:[0-9a-f]{64}$`));
      expect(keys[0]).not.toMatch(/127\.0\.0\.1|::1|ffff/);
    } finally {
      await Promise.all(apps.map((app) => app.close()));
    }
  });

  it('counts in memory while Redis does not answer in time, and goes back to Redis after the pause', async () => {
    const { counters: paused, clock } = counters();
    await paused.consume('public-search', KEY);

    await admin.call('CLIENT', 'PAUSE', '1500', 'ALL');
    try {
      const started = Date.now();
      for (let index = 0; index < BREAKER_FAILURES_TO_OPEN + 2; index += 1) {
        await expect(paused.consume('public-search', KEY)).resolves.toMatchObject({
          count: index + 1,
        });
      }
      // Each failed try waited at most the command timeout; the open circuit waited for nothing.
      expect(Date.now() - started).toBeLessThan(BREAKER_FAILURES_TO_OPEN * 200 + 600);
      expect(paused.stats()).toEqual({ state: 'memory', fallbackRequests: 5 });
    } finally {
      await admin.call('CLIENT', 'UNPAUSE');
    }

    clock.advance(Temporal.Duration.from({ milliseconds: BREAKER_OPEN_MS }));
    const back = await paused.consume('public-search', KEY);

    expect(paused.stats().state).toBe('redis');
    // The timed-out commands may still have run on Redis once it answered again.
    expect(back.count).toBeGreaterThanOrEqual(2);
  });

  it('runs on the ACL-limited rate-limit user, which can do nothing else', async () => {
    const username = `rl-test-${randomBytes(4).toString('hex')}`;
    const password = randomBytes(24).toString('hex');
    await admin.call('ACL', 'SETUSER', username, ...RATE_LIMIT_ACL, `>${password}`);
    try {
      const limited = new RateLimitRedis(connectionOf(testRedisUrl(), { username, password }));
      opened.push(limited);
      const clock = new FixedClock(Temporal.Instant.from('2026-11-26T10:00:00Z'));
      const counted = new RedisRateLimitCounters(limited, clock, prefix);

      // Twice: the first runs EVALSHA, gets NOSCRIPT and falls back to EVAL; the second EVALSHA.
      await counted.consume('public-media', KEY);
      await expect(counted.consume('public-media', KEY)).resolves.toMatchObject({ count: 2 });
      expect(counted.stats()).toEqual({ state: 'redis', fallbackRequests: 0 });

      await expect(limited.client.keys('*')).rejects.toThrow(/NOPERM/);
      await expect(limited.client.set('session:x', '1')).rejects.toThrow(/NOPERM/);
      await expect(limited.client.call('SCRIPT', 'FLUSH')).rejects.toThrow(/NOPERM/);
    } finally {
      await admin.call('ACL', 'DELUSER', username);
    }
  });
});
