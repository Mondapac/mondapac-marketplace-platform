import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import type { RateLimitRedis } from './rate-limit-redis';
import {
  BREAKER_FAILURES_TO_OPEN,
  BREAKER_OPEN_MS,
  RedisRateLimitCounters,
  STORE_DEGRADED,
  STORE_LOG_EVERY_MS,
  STORE_RECOVERED,
} from './redis-rate-limit-counters';

const KEY = 'a'.repeat(64);

/**
 * A stand-in of the ioredis client, as far as the package's Redis store uses it: the `status`
 * it checks (`rejectIfRedisNotReady`) and the Lua command it defines. Counts per key in a map.
 */
class FakeRedis {
  status = 'ready';
  failing: Error | null = null;
  readonly counts = new Map<string, number>();
  readonly keys: string[] = [];
  calls = 0;

  defineCommand(): void {}

  /** The package opens a MULTI before it picks the Lua command; only the command is used. */
  multi(): object {
    return {};
  }

  rlflxIncr([key]: string[]): Promise<[number, number]> {
    this.calls += 1;
    if (this.failing !== null) return Promise.reject(this.failing);
    this.keys.push(key!);
    const count = (this.counts.get(key!) ?? 0) + 1;
    this.counts.set(key!, count);
    return Promise.resolve([count, 60_000]);
  }
}

function setUp() {
  const fake = new FakeRedis();
  const clock = new FixedClock(Temporal.Instant.from('2026-11-26T10:00:00Z'));
  const connection = {
    client: fake,
    firstConnection: () => Promise.resolve(),
  } as unknown as Pick<RateLimitRedis, 'client' | 'firstConnection'>;
  const counters = new RedisRateLimitCounters(connection, clock, 'rl:unit');
  return { fake, clock, counters };
}

describe('RedisRateLimitCounters (ADR-0054)', () => {
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('counts in Redis under rl:<prefix>:<class>:<key>', async () => {
    const { fake, counters } = setUp();

    await counters.consume('default', KEY);
    const second = await counters.consume('default', KEY);
    await counters.consume('public-media', KEY);

    expect(second).toEqual({ count: 2, msBeforeNext: 60_000 });
    expect(fake.keys).toEqual([
      `rl:unit:default:${KEY}`,
      `rl:unit:default:${KEY}`,
      `rl:unit:public-media:${KEY}`,
    ]);
    expect(counters.stats()).toEqual({ state: 'redis', fallbackRequests: 0 });
  });

  it('counts in memory when Redis fails, and never rejects', async () => {
    const { fake, counters } = setUp();
    fake.failing = new Error('Command timed out');

    const first = await counters.consume('default', KEY);
    const second = await counters.consume('default', KEY);

    expect(first.count).toBe(1);
    expect(second.count).toBe(2);
    expect(counters.stats().fallbackRequests).toBe(2);
  });

  it('opens the circuit after the failures in a row: memory only, then one try after the pause', async () => {
    const { fake, clock, counters } = setUp();
    fake.failing = new Error('Command timed out');

    for (let index = 0; index < BREAKER_FAILURES_TO_OPEN; index += 1) {
      await counters.consume('default', KEY);
    }
    expect(fake.calls).toBe(BREAKER_FAILURES_TO_OPEN);
    expect(counters.stats().state).toBe('memory');

    // Open: Redis is not asked at all, so a slow Redis adds nothing to these requests.
    await counters.consume('default', KEY);
    await counters.consume('public-search', KEY);
    expect(fake.calls).toBe(BREAKER_FAILURES_TO_OPEN);

    // After the pause one request tries Redis; still failing, the circuit opens again.
    clock.advance(Temporal.Duration.from({ milliseconds: BREAKER_OPEN_MS }));
    await counters.consume('default', KEY);
    await counters.consume('default', KEY);
    expect(fake.calls).toBe(BREAKER_FAILURES_TO_OPEN + 1);

    // Redis is back: the next try succeeds and counts in Redis again.
    fake.failing = null;
    clock.advance(Temporal.Duration.from({ milliseconds: BREAKER_OPEN_MS }));
    await expect(counters.consume('default', KEY)).resolves.toEqual({
      count: 1,
      msBeforeNext: 60_000,
    });
    expect(counters.stats()).toEqual({ state: 'redis', fallbackRequests: 7 });
  });

  it('logs the change of state once, with the class and a fixed code only, then the recovery', async () => {
    const { fake, clock, counters } = setUp();
    fake.failing = new Error('Command timed out');

    for (let index = 0; index < 10; index += 1) await counters.consume('default', KEY);
    clock.advance(Temporal.Duration.from({ milliseconds: BREAKER_OPEN_MS }));
    await counters.consume('default', KEY);

    const degraded = warn.mock.calls.filter(
      ([line]) => (line as { msg?: string }).msg === STORE_DEGRADED,
    );
    expect(degraded).toEqual([
      [
        {
          msg: STORE_DEGRADED,
          store: 'redis',
          fallback: 'memory',
          limitClass: 'default',
          errorCode: 'command-timeout',
        },
      ],
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(KEY);

    fake.failing = null;
    clock.advance(Temporal.Duration.from({ milliseconds: BREAKER_OPEN_MS }));
    await counters.consume('default', KEY);

    expect(log.mock.calls).toEqual([
      [{ msg: STORE_RECOVERED, store: 'redis', fallbackRequests: 11 }],
    ]);
  });

  it('writes at most one store-state line per 30 seconds while Redis flaps', async () => {
    const { fake, clock, counters } = setUp();
    const flap = async () => {
      fake.failing = new Error('Connection is closed.');
      for (let index = 0; index < BREAKER_FAILURES_TO_OPEN; index += 1) {
        await counters.consume('default', KEY);
      }
      fake.failing = null;
      clock.advance(Temporal.Duration.from({ milliseconds: BREAKER_OPEN_MS }));
      await counters.consume('default', KEY);
    };

    await flap();
    await flap();
    await flap();

    // Both loggers' calls, in the order they were made.
    const lines = (): [unknown][] =>
      [warn, log]
        .flatMap((spy) =>
          (spy.mock.calls as [unknown][]).map((call, index) => ({
            call,
            order: spy.mock.invocationCallOrder[index]!,
          })),
        )
        .sort((left, right) => left.order - right.order)
        .map(({ call }) => call)
        .filter(([line]) =>
          [STORE_DEGRADED, STORE_RECOVERED].includes((line as { msg?: string }).msg ?? ''),
        );
    // The first outage and its recovery are logged; the next two fall inside the 30 seconds.
    expect(lines().map(([line]) => (line as { msg: string }).msg)).toEqual([
      STORE_DEGRADED,
      STORE_RECOVERED,
    ]);

    clock.advance(Temporal.Duration.from({ milliseconds: STORE_LOG_EVERY_MS }));
    await flap();
    expect(lines().map(([line]) => (line as { msg: string }).msg)).toEqual([
      STORE_DEGRADED,
      STORE_RECOVERED,
      STORE_DEGRADED,
      STORE_RECOVERED,
    ]);
  });
});
