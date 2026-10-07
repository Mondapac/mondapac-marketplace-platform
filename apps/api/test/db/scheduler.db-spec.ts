import { Logger } from '@nestjs/common';
import { isMinted, Temporal } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import { SystemClock } from '../../src/platform/clock/system-clock';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import type { MarketConfig } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { MarketContextFactory } from '../../src/platform/market-context/market-context.factory';
import { PLATFORM_TENANT_ID } from '../../src/platform/market-context/tenant';
import { AdvisoryJobLock } from '../../src/platform/persistence/advisory-job-lock';
import { jobLockKey } from '../../src/platform/scheduler/job-lock';
import { JobRegistry, type JobContext } from '../../src/platform/scheduler/job-registry';
import { Scheduler } from '../../src/platform/scheduler/scheduler';
import { TEST_MARKET_IDS } from '../support/test-config';
import { createPersistence, gate, type Persistence } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Platform persistence design ("P") 7 and the row "Scheduler" of 13, for both Market fixtures,
// on the real advisory lock as the application role: two runners and one lock run the job
// once; a job that fails for AU still runs for ZZ; each run gets its Market's system actor and
// its own correlation id. Ali's F2: the lock transaction survives the login role's idle timeout.

const NAME = 'identity.test-job';

function schedulerOn(db: Persistence, run: (context: JobContext) => Promise<void>) {
  const registry = new JobRegistry();
  registry.register('identity', [{ name: NAME, every: Temporal.Duration.from({ hours: 1 }), run }]);
  const markets = new MarketRegistry(
    new Map(TEST_MARKET_IDS.map((id) => [id, {} as MarketConfig] as const)),
  );
  return new Scheduler(
    registry,
    new AdvisoryJobLock(db.root),
    markets,
    new MarketContextFactory(markets, PLATFORM_TENANT_ID),
    new UuidV7IdGenerator(new SystemClock()),
  );
}

/** The advisory locks held on the key of {@link NAME}, read from another session. */
async function holdersOf(sql: Client): Promise<number> {
  const key = BigInt.asUintN(64, jobLockKey(NAME));
  const { rows } = await sql.query<{ count: string }>(
    `SELECT count(*) FROM pg_locks
      WHERE locktype = 'advisory' AND granted AND objsubid = 1
        AND classid::bigint = $1 AND objid::bigint = $2`,
    [(key >> 32n).toString(), (key & 0xffffffffn).toString()],
  );
  return Number(rows[0]!.count);
}

describe('scheduler (database integration)', () => {
  let first: Persistence;
  let second: Persistence;
  let sql: Client;
  let errors: jest.SpyInstance;

  beforeAll(async () => {
    first = createPersistence();
    second = createPersistence();
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });

  afterAll(async () => {
    await sql.end();
    await first.close();
    await second.close();
  });

  beforeEach(() => {
    errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errors.mockRestore();
  });

  it('two runners and one lock run the job once; the lock is held for the run and freed after', async () => {
    const held = gate();
    const started = gate();
    const runs: string[] = [];
    const job = async (context: JobContext) => {
      runs.push(context.market.marketId);
      started.open();
      await held.opened;
    };

    const running = schedulerOn(first, job).runJobOnce(NAME);
    await started.opened;
    expect(await holdersOf(sql)).toBe(1);
    const skipped = await schedulerOn(second, job).runJobOnce(NAME);
    held.open();

    expect(skipped).toEqual({ outcome: 'skipped' });
    await expect(running).resolves.toEqual({ outcome: 'ran', failedMarkets: [] });
    expect(runs).toEqual(['AU', 'ZZ']);
    expect(await holdersOf(sql)).toBe(0);
    await expect(schedulerOn(second, () => Promise.resolve()).runJobOnce(NAME)).resolves.toEqual({
      outcome: 'ran',
      failedMarkets: [],
    });
  });

  it('a job that fails for AU still runs for ZZ; each run has its Market and its own correlation id', async () => {
    const seen: JobContext[] = [];
    const result = await schedulerOn(first, (context) => {
      seen.push(context);
      return context.market.marketId === 'AU'
        ? Promise.reject(new Error('AU failed'))
        : Promise.resolve();
    }).runJobOnce(NAME);

    expect(result).toEqual({ outcome: 'ran', failedMarkets: ['AU'] });
    expect(seen.map((context) => context.market.marketId)).toEqual(['AU', 'ZZ']);
    expect(seen.every((context) => isMinted(context.market))).toBe(true);
    // P 13: each run gets the system actor of its Market, in a minted CallContext.
    expect(seen.every((context) => isMinted(context))).toBe(true);
    expect(seen.map((context) => [context.actor.kind, context.actor.marketId])).toEqual([
      ['system', 'AU'],
      ['system', 'ZZ'],
    ]);
    expect(new Set(seen.map((context) => context.correlationId)).size).toBe(2);
    expect(errors).toHaveBeenCalledWith(
      expect.objectContaining({ msg: 'job.failed', job: NAME, marketId: 'AU' }),
    );
  });

  it("keeps the lock transaction open past the session's idle-in-transaction timeout (F2)", async () => {
    // A pool whose sessions end after 1 s idle in a transaction, like the login role's 60 s.
    const short = createPersistence({
      urlParameters: { options: '-c idle_in_transaction_session_timeout=1000' },
    });
    try {
      const result = await schedulerOn(short, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }).runJobOnce(NAME);

      expect(result).toEqual({ outcome: 'ran', failedMarkets: [] });
      expect(await holdersOf(sql)).toBe(0);
    } finally {
      await short.close();
    }
  });
});
