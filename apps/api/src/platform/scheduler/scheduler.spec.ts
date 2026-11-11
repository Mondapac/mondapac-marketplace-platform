import { Logger } from '@nestjs/common';
import { isMinted, Temporal } from '@mondapac/shared-kernel';
import { FixedClock, SequenceIdGenerator } from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_IDS } from '../../../test/support/test-config';
import type { MarketConfig } from '../market-config/market-config';
import { MarketRegistry } from '../market-config/market-registry';
import { MarketContextFactory } from '../market-context/market-context.factory';
import { PLATFORM_TENANT_ID } from '../market-context/tenant';
import { jobLockKey, type JobLock, type JobLockOutcome } from './job-lock';
import { JobRegistry, type JobContext, type JobDefinition } from './job-registry';
import { jobRunBoundsOf, laneOf, Scheduler, UnknownJobError, type JobRunBounds } from './scheduler';

/** One lock shared by the schedulers of a test: the advisory lock without a database. */
class InMemoryJobLock implements JobLock {
  readonly held = new Set<bigint>();
  readonly calls: { key: bigint; maxRunMs: number }[] = [];

  async runExclusive(
    key: bigint,
    maxRunMs: number,
    work: () => Promise<void>,
  ): Promise<JobLockOutcome> {
    this.calls.push({ key, maxRunMs });
    if (this.held.has(key)) return 'skipped';
    this.held.add(key);
    try {
      await work();
      return 'ran';
    } finally {
      this.held.delete(key);
    }
  }
}

const NAME = 'identity.purge-expired';

function setup(
  run: (context: JobContext) => Promise<void>,
  overrides: Partial<JobDefinition> = {},
) {
  const registry = new JobRegistry();
  registry.register('identity', [
    { name: NAME, every: Temporal.Duration.from({ hours: 1 }), run, ...overrides },
  ]);
  const markets = new MarketRegistry(
    new Map(TEST_MARKET_IDS.map((id) => [id, {} as MarketConfig])),
  );
  const contexts = new MarketContextFactory(markets, PLATFORM_TENANT_ID);
  const ids = new SequenceIdGenerator(
    new FixedClock(Temporal.Instant.from('2026-10-07T00:00:00Z')),
  );
  const lock = new InMemoryJobLock();
  const scheduler = (jitter = () => 0) =>
    new Scheduler(registry, lock, markets, contexts, ids, jitter);
  return { lock, scheduler };
}

describe('Scheduler.runJobOnce (platform persistence design 7)', () => {
  let errors: jest.SpyInstance;

  beforeEach(() => {
    errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errors.mockRestore();
  });

  it('runs once per hosted Market, AU and ZZ, each with its own minted context and correlation id', async () => {
    const seen: JobContext[] = [];
    const { scheduler, lock } = setup((context) => {
      seen.push(context);
      return Promise.resolve();
    });

    await expect(scheduler().runJobOnce(NAME)).resolves.toEqual({
      outcome: 'ran',
      failedMarkets: [],
    });

    expect(seen.map((context) => context.market.marketId)).toEqual(['AU', 'ZZ']);
    expect(seen.every((context) => isMinted(context.market))).toBe(true);
    // A minted CallContext with that Market's system actor (identity slice 1c; Hassan, 1b I3).
    expect(seen.every((context) => isMinted(context) && isMinted(context.actor))).toBe(true);
    expect(seen.map((context) => context.actor)).toEqual([
      { kind: 'system', marketId: 'AU' },
      { kind: 'system', marketId: 'ZZ' },
    ]);
    expect(seen.every((context) => context.market.tenantId === PLATFORM_TENANT_ID)).toBe(true);
    expect(new Set(seen.map((context) => context.correlationId)).size).toBe(2);
    expect(lock.calls).toEqual([{ key: jobLockKey(NAME), maxRunMs: 60_000 }]);
  });

  it('runs ZZ when AU fails, and logs the failure with job, Market and correlation id', async () => {
    const seen: string[] = [];
    const { scheduler } = setup((context) => {
      seen.push(context.market.marketId);
      return context.market.marketId === 'AU'
        ? Promise.reject(new Error('boom'))
        : Promise.resolve();
    });

    await expect(scheduler().runJobOnce(NAME)).resolves.toEqual({
      outcome: 'ran',
      failedMarkets: ['AU'],
    });

    expect(seen).toEqual(['AU', 'ZZ']);
    expect(errors).toHaveBeenCalledWith(
      expect.objectContaining({
        msg: 'job.failed',
        job: NAME,
        marketId: 'AU',
        correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
      }),
    );
  });

  it('skips the run when another runner holds the lock: two runners, one lock, one run', async () => {
    let release!: () => void;
    let runs = 0;
    const { scheduler } = setup(async () => {
      runs += 1;
      await new Promise<void>((resolve) => (release = resolve));
    });

    const first = scheduler().runJobOnce(NAME);
    await new Promise((resolve) => setImmediate(resolve));
    const second = await scheduler().runJobOnce(NAME);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    release();

    expect(second).toEqual({ outcome: 'skipped' });
    await expect(first).resolves.toMatchObject({ outcome: 'ran' });
    expect(runs).toBe(2); // once per Market, by the first runner only
  });

  it('passes the declared maxRunMs to the lock', async () => {
    const { scheduler, lock } = setup(() => Promise.resolve(), { maxRunMs: 120_000 });

    await scheduler().runJobOnce(NAME);

    expect(lock.calls[0]?.maxRunMs).toBe(120_000);
  });

  it('refuses an unknown job', async () => {
    const { scheduler } = setup(() => Promise.resolve());

    await expect(scheduler().runJobOnce('identity.unknown')).rejects.toBeInstanceOf(
      UnknownJobError,
    );
  });
});

describe('Scheduler.start and stop', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('starts nothing on construction; ticks first after the jittered part, then every interval', async () => {
    const run = jest.fn(() => Promise.resolve());
    const { scheduler } = setup(run);
    const instance = scheduler(() => 0.25);

    await jest.advanceTimersByTimeAsync(3 * 3_600_000);
    expect(run).not.toHaveBeenCalled();

    instance.start();
    await jest.advanceTimersByTimeAsync(900_000 - 1);
    expect(run).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2); // AU and ZZ
    await jest.advanceTimersByTimeAsync(3_600_000);
    expect(run).toHaveBeenCalledTimes(4);

    await instance.stop(10_000);
    await jest.advanceTimersByTimeAsync(10 * 3_600_000);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('ticks a job declared runAtStart at once, whatever the jitter, then every interval', async () => {
    const run = jest.fn(() => Promise.resolve());
    const { scheduler } = setup(run, { runAtStart: true });
    const instance = scheduler(() => 0.75);

    instance.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2); // AU and ZZ
    await jest.advanceTimersByTimeAsync(3_600_000);
    expect(run).toHaveBeenCalledTimes(4);

    await instance.stop(10_000);
  });
});

describe('Scheduler: bounded runs in flight (the pool stays free for the relay)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  interface GatedJob {
    readonly name: string;
    readonly maxRunMs?: number;
  }

  /** runAtStart jobs that each run until their gate opens; `log` records starts and ends. */
  function gatedJobs(jobs: readonly GatedJob[], every = Temporal.Duration.from({ hours: 1 })) {
    const log: string[] = [];
    const gates = new Map<string, () => void>();
    const registry = new JobRegistry();
    registry.register(
      'identity',
      jobs.map(({ name, maxRunMs }) => ({
        name,
        every,
        runAtStart: true,
        ...(maxRunMs === undefined ? {} : { maxRunMs }),
        run: async (context: JobContext) => {
          // One record per run: the first Market waits on the gate, the second runs through.
          if (context.market.marketId !== TEST_MARKET_IDS[0]) return;
          log.push(`start ${name}`);
          await new Promise<void>((resolve) => gates.set(name, resolve));
          log.push(`end ${name}`);
        },
      })),
    );
    const markets = new MarketRegistry(
      new Map(TEST_MARKET_IDS.map((id) => [id, {} as MarketConfig])),
    );
    const contexts = new MarketContextFactory(markets, PLATFORM_TENANT_ID);
    const ids = new SequenceIdGenerator(
      new FixedClock(Temporal.Instant.from('2026-10-07T00:00:00Z')),
    );
    const scheduler = (bounds: JobRunBounds) =>
      new Scheduler(registry, new InMemoryJobLock(), markets, contexts, ids, () => 0, bounds);
    const open = async (name: string) => {
      gates.get(name)!();
      gates.delete(name);
      await jest.advanceTimersByTimeAsync(0);
    };
    return { log, scheduler, open };
  }

  const LONG = 10 * 60_000;

  it('gives a third of the pool to job runs, at least two, one of them for long jobs', () => {
    expect(jobRunBoundsOf(10)).toEqual({ short: 2, long: 1 });
    expect(jobRunBoundsOf(20)).toEqual({ short: 5, long: 1 });
    expect(jobRunBoundsOf(3)).toEqual({ short: 1, long: 1 });
    expect(jobRunBoundsOf(1)).toEqual({ short: 1, long: 1 });
  });

  it('puts a job declared to run past 2 minutes in the long lane', () => {
    expect(laneOf({})).toBe('short');
    expect(laneOf({ maxRunMs: 120_000 })).toBe('short');
    expect(laneOf({ maxRunMs: 120_001 })).toBe('long');
    expect(laneOf({ maxRunMs: 300_000 })).toBe('long');
  });

  it('starts at most the bound of a lane at once and the rest as runs end, in order', async () => {
    const { log, scheduler, open } = gatedJobs([
      { name: 'identity.a' },
      { name: 'identity.b' },
      { name: 'identity.c' },
    ]);
    const instance = scheduler({ short: 2, long: 1 });

    instance.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(log).toEqual(['start identity.a', 'start identity.b']);

    await open('identity.b');
    expect(log).toEqual([
      'start identity.a',
      'start identity.b',
      'end identity.b',
      'start identity.c',
    ]);

    await open('identity.a');
    await open('identity.c');
    expect(log.filter((line) => line.startsWith('start'))).toHaveLength(3);

    await instance.stop(10_000);
  });

  it('never lets long runs take the short lane: short jobs run while two imports wait in turn', async () => {
    const { log, scheduler, open } = gatedJobs([
      { name: 'identity.import-a', maxRunMs: LONG },
      { name: 'identity.import-b', maxRunMs: LONG },
      { name: 'identity.payments' },
    ]);
    const instance = scheduler({ short: 1, long: 1 });

    instance.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(log).toEqual(['start identity.import-a', 'start identity.payments']);

    await open('identity.import-a');
    expect(log).toEqual([
      'start identity.import-a',
      'start identity.payments',
      'end identity.import-a',
      'start identity.import-b',
    ]);

    await open('identity.payments');
    await open('identity.import-b');
    await instance.stop(10_000);
  });

  it('queues a waiting job once however often it ticks, drops ticks of a job in flight, and stop drops the queue', async () => {
    const { log, scheduler, open } = gatedJobs(
      [{ name: 'identity.a' }, { name: 'identity.b' }],
      Temporal.Duration.from({ seconds: 5 }),
    );
    const instance = scheduler({ short: 1, long: 1 });

    instance.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(log).toEqual(['start identity.a']);

    // a holds the only slot for 25 s: b's six ticks queue it once, and a's own ticks are
    // dropped, so when a ends only b starts.
    await jest.advanceTimersByTimeAsync(25_000);
    await open('identity.a');
    expect(log).toEqual(['start identity.a', 'end identity.a', 'start identity.b']);

    // stop drops what is queued: when b ends, nothing else starts.
    await jest.advanceTimersByTimeAsync(5_000);
    const stopped = instance.stop(10_000);
    await jest.advanceTimersByTimeAsync(10_000);
    await stopped;
    await open('identity.b');
    await jest.advanceTimersByTimeAsync(60_000);
    expect(log).toEqual([
      'start identity.a',
      'end identity.a',
      'start identity.b',
      'end identity.b',
    ]);
  });
});
