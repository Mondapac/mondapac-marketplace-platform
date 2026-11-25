import { randomBytes } from 'node:crypto';
import { devNull } from 'node:os';
import type { INestApplicationContext } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import pino from 'pino';
import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import { AppModule } from '../../src/app.module';
import { AI_ROUTE_CATALOGUE } from '../../src/platform/ai/catalogue/route-catalogue';
import { AiEvaluationControl } from '../../src/platform/ai/evaluations/evaluation-control';
import { AiEvaluationRunner } from '../../src/platform/ai/evaluations/evaluation-runner';
import {
  AI_EVALUATION_STORE,
  type AiEvaluationStore,
  type EvaluationSampleRecord,
} from '../../src/platform/ai/evaluations/evaluation-store';
import { MODEL_PROVIDER, type ModelProvider } from '../../src/platform/ai/model-provider';
import type { JobContext } from '../../src/platform/scheduler/job-registry';
import { CLOCK } from '../../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../../src/platform/market-context/tenant';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import { testRouteCatalogue } from '../support/ai-routes';
import { testAppConfig, TEST_MARKETS } from '../support/test-config';
import { testDatabaseUrl } from './test-database';

// AI Gateway G4c (docs/design/domain/platform-ai.md sections 8 and 10): the evaluation tables in a
// real database. One open run per model and Market (the partial unique index), one claim of two
// concurrent ones, a renewal only with the run's token, a sample inserted once, the playground's
// daily count under concurrency, retention, the CHECKs, Market isolation, and the runner end to end
// with catalog's suites and a fake provider, counted only on the evaluation budget. Both Markets.

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';
const NOW = Temporal.Instant.from('2026-11-25T02:00:00Z');
const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);
const uuid = () => uuidV7(Date.now(), randomBytes(10));
const LEASE = Temporal.Duration.from({ seconds: 150 });

describe('platform AI evaluations (database integration, AI Gateway G4c)', () => {
  const clock = new FixedClock(NOW);
  let app: INestApplicationContext;
  let store: AiEvaluationStore;
  let unitOfWork: UnitOfWork;
  let runner: AiEvaluationRunner;
  let control: AiEvaluationControl;
  let sql: Client;
  const provider: ModelProvider = {
    call: () =>
      Promise.resolve({
        blocks: [{ type: 'text', text: 'Tilda Sella basmati rice, aged 2 years.' }],
        stop: 'end',
        usage: { inputTokens: 100, outputTokens: 20 },
      }),
  };

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.register({
          config: testAppConfig({
            DATABASE_URL: testDatabaseUrl(),
            ASSISTANT_MODEL_API_KEY: 'AU=sk-test-canary-key-0001,ZZ=sk-test-canary-key-0002',
            ASSISTANT_MODEL_FAST: 'AU=model-fast,ZZ=model-fast',
          }),
          logDestination: pino.destination(devNull),
        }),
      ],
    })
      .overrideProvider(CLOCK)
      .useValue(clock)
      .overrideProvider(MODEL_PROVIDER)
      .useValue(provider)
      .overrideProvider(AI_ROUTE_CATALOGUE)
      .useValue(testRouteCatalogue())
      .compile();
    app = await moduleRef.init();
    store = app.get(AI_EVALUATION_STORE);
    unitOfWork = app.get(UNIT_OF_WORK);
    runner = app.get(AiEvaluationRunner);
    control = app.get(AiEvaluationControl);
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });

  afterAll(async () => {
    await sql.end();
    await app.close();
    jest.restoreAllMocks();
  });

  const write = async <T>(market: MarketContext, work: () => Promise<T>): Promise<T> => {
    const result = await unitOfWork.run(market, async () => ok(await work()));
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };

  const newRun = (family: string, requestedAt = clock.now()) => ({
    id: uuid(),
    provider: 'anthropic',
    family,
    requestedBy: uuid(),
    requestedAt,
    estimateMicroUsd: 500,
    capabilities: [
      {
        capability: 'catalog.description-writer.admin',
        promptVersion: 'p-1',
        setVersion: 's-1',
        samplesTotal: 2,
      },
    ],
  });

  /** A family no other case uses, so cases never meet on the open-run index. */
  const family = () => `fam-${randomBytes(3).toString('hex')}`;

  const sample = (sampleId: string): EvaluationSampleRecord => ({
    capability: 'catalog.description-writer.admin',
    sampleId,
    outcome: 'ok',
    checks: [],
    callId: uuid(),
    route: 'anthropic-api',
    attempt: 1,
    inputTokens: 10,
    outputTokens: 5,
    costMicroUsd: 30,
    latencyMs: 400,
    finishedAt: clock.now(),
  });

  const setSetting = async (market: MarketContext, code: string, value: string) => {
    await sql.query(
      `INSERT INTO settings.market_settings
         (market_id, tenant_id, code, value, version, updated_at, updated_by_account_id)
       VALUES ($1, $2, $3, $4, 1, now(), $5)
       ON CONFLICT (market_id, code)
       DO UPDATE SET value = EXCLUDED.value, version = settings.market_settings.version + 1`,
      [market.marketId, PLATFORM_TENANT_ID, code, value, uuid()],
    );
  };

  describe.each(TEST_MARKETS)('Market %s', (code) => {
    const market = marketOf(code);
    const other = marketOf(code === 'AU' ? 'ZZ' : 'AU');

    it('keeps one open run per model and Market (the partial unique index)', async () => {
      const name = family();
      const first = newRun(name);
      expect(await write(market, () => store.enqueue(market, first))).toBe(true);
      expect(await write(market, () => store.enqueue(market, newRun(name)))).toBe(false);
      expect(await write(other, () => store.enqueue(other, newRun(name)))).toBe(true);
      // The index itself refuses a second open row written past the store.
      await expect(
        sql.query(
          `INSERT INTO platform.ai_evaluation_runs
             (market_id, id, tenant_id, provider, family, status, requested_by, requested_at,
              estimate_micro_usd)
           VALUES ($1, $2, $3, 'anthropic', $4, 'queued', $5, now(), 0)`,
          [code, uuid(), PLATFORM_TENANT_ID, name, uuid()],
        ),
      ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
      // Once it ended, the model may be run again.
      expect(await write(market, () => store.cancel(market, first.id, clock.now()))).toBe(true);
      expect(await write(market, () => store.enqueue(market, newRun(name)))).toBe(true);
      // Another Market never sees it.
      expect(await write(other, () => store.findRun(other, first.id))).toBeNull();
    });

    it('lets one of two concurrent claims take a run, and renews only with its token', async () => {
      const run = newRun(family());
      await write(market, () => store.enqueue(market, run));
      const now = clock.now();
      const claims = await Promise.all(
        ['01990000-0000-7000-8000-00000000aa01', '01990000-0000-7000-8000-00000000aa02'].map(
          (token) => write(market, () => store.claim(market, run.id, token, now, now.add(LEASE))),
        ),
      );
      expect(claims.filter(Boolean)).toHaveLength(1);
      const winner = claims[0]
        ? '01990000-0000-7000-8000-00000000aa01'
        : '01990000-0000-7000-8000-00000000aa02';
      const loser = claims[0]
        ? '01990000-0000-7000-8000-00000000aa02'
        : '01990000-0000-7000-8000-00000000aa01';
      expect(await write(market, () => store.renew(market, run.id, loser, now.add(LEASE)))).toBe(
        'lost',
      );
      expect(await write(market, () => store.renew(market, run.id, winner, now.add(LEASE)))).toBe(
        'renewed',
      );
      // Held: no claim before the lease runs out; after it, another job takes it.
      expect(await write(market, () => store.claimable(market, now, 50))).not.toContain(run.id);
      const later = now.add(LEASE).add({ seconds: 1 });
      expect(await write(market, () => store.claimable(market, later, 50))).toContain(run.id);
      expect(
        await write(market, () => store.claim(market, run.id, loser, later, later.add(LEASE))),
      ).toBe(true);
      expect(await write(market, () => store.renew(market, run.id, winner, later))).toBe('lost');
      expect(
        await write(market, () => store.finish(market, run.id, winner, 'completed', later)),
      ).toBe(false);
      // A cancelled run answers `ended`.
      await write(market, () => store.cancel(market, run.id, later));
      expect(await write(market, () => store.renew(market, run.id, loser, later))).toBe('ended');
    });

    it('inserts a sample once and sets a verdict only while pending', async () => {
      const run = newRun(family());
      await write(market, () => store.enqueue(market, run));
      expect(await write(market, () => store.addSample(market, run.id, sample('plain')))).toBe(
        true,
      );
      expect(await write(market, () => store.addSample(market, run.id, sample('plain')))).toBe(
        false,
      );
      expect(await write(market, () => store.samplesOf(market, run.id))).toHaveLength(1);
      const capability = 'catalog.description-writer.admin';
      await write(market, () => store.setVerdict(market, run.id, capability, 'failed'));
      await write(market, () => store.setVerdict(market, run.id, capability, 'pass-candidate'));
      expect(
        (await write(market, () => store.capabilitiesOf(market, run.id))).map((r) => r.verdict),
      ).toEqual(['failed']);
    });

    it('counts at most the limit of concurrent playground runs per admin and day', async () => {
      const admin = uuid();
      const day = Temporal.PlainDate.from('2026-11-25');
      const taken = await Promise.all(
        Array.from({ length: 25 }, () =>
          write(market, () => store.takePlaygroundRun(market, day, admin, 20)),
        ),
      );
      expect(taken.filter(Boolean)).toHaveLength(20);
      expect(await write(other, () => store.takePlaygroundRun(other, day, admin, 20))).toBe(true);
    });

    it('purges ended runs and old playground days, never an open run', async () => {
      const old = Temporal.Instant.from('2020-01-01T00:00:00Z');
      const ended = newRun(family(), old);
      const open = newRun(family(), old);
      await write(market, () => store.enqueue(market, ended));
      await write(market, () => store.enqueue(market, open));
      await write(market, () => store.addSample(market, ended.id, sample('plain')));
      await write(market, () => store.cancel(market, ended.id, old));
      const before = Temporal.Instant.from('2024-01-01T00:00:00Z');
      expect(
        await write(market, () => store.purgeRuns(market, before, 500)),
      ).toBeGreaterThanOrEqual(1);
      expect(await write(market, () => store.findRun(market, ended.id))).toBeNull();
      expect(await write(market, () => store.findRun(market, open.id))).not.toBeNull();
      await write(market, () =>
        store.takePlaygroundRun(market, Temporal.PlainDate.from('2020-01-01'), uuid(), 20),
      );
      expect(
        await write(market, () =>
          store.purgePlaygroundDays(market, Temporal.PlainDate.from('2024-01-01'), 500),
        ),
      ).toBeGreaterThanOrEqual(1);
      await write(market, () => store.cancel(market, open.id, clock.now()));
    });

    it('refuses an unknown status, verdict or check code (CHECKs)', async () => {
      const run = newRun(family());
      await write(market, () => store.enqueue(market, run));
      await expect(
        sql.query(
          `UPDATE platform.ai_evaluation_runs SET status = 'passed' WHERE market_id = $1 AND id = $2`,
          [code, run.id],
        ),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
      await expect(
        sql.query(
          `UPDATE platform.ai_evaluation_capabilities SET verdict = 'pass'
            WHERE market_id = $1 AND run_id = $2`,
          [code, run.id],
        ),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
      await expect(
        write(market, () =>
          store.addSample(market, run.id, { ...sample('plain'), checks: ['nice' as never] }),
        ),
      ).rejects.toThrow();
      await write(market, () => store.cancel(market, run.id, clock.now()));
    });

    it('works a queued run end to end with catalog suites, on the evaluation budget only', async () => {
      await setSetting(market, 'ai-cap-evaluation-month', '100000000');
      const context = testCallContext(market, 'system');
      const estimate = await control.estimate(context, 'anthropic', 'model-fast');
      expect(estimate.blockers).toEqual([]);
      expect(estimate.capabilities.length).toBeGreaterThan(0);
      const runId = await write(market, () => control.enqueue(market, estimate, uuid()));
      expect(runId).not.toBeNull();
      const before = await sql.query<{ scope: string }>(
        `SELECT DISTINCT scope FROM platform.ai_budget_counters WHERE market_id = $1`,
        [code],
      );
      const outcome = await runner.tick(context as JobContext, 295_000);
      expect(outcome).toEqual({ runId, stop: 'completed' });
      const detail = await control.detail(market, runId!);
      expect(detail?.run.status).toBe('completed');
      const total = estimate.capabilities.reduce((sum, item) => sum + item.samples, 0);
      expect(detail?.samples).toHaveLength(total);
      expect(detail?.capabilities.every((row) => row.verdict !== 'pending')).toBe(true);
      const after = await sql.query<{ scope: string; spent: string }>(
        `SELECT scope, spent_micro_usd AS spent FROM platform.ai_budget_counters
          WHERE market_id = $1 AND scope = 'evaluation'`,
        [code],
      );
      expect(after.rows).toHaveLength(1);
      expect(Number(after.rows[0]!.spent)).toBeGreaterThan(0);
      // No other scope appeared for the run's calls.
      const scopes = await sql.query<{ scope: string }>(
        `SELECT DISTINCT scope FROM platform.ai_budget_counters WHERE market_id = $1`,
        [code],
      );
      expect(scopes.rows.map((row) => row.scope).sort()).toEqual(
        [...new Set([...before.rows.map((row) => row.scope), 'evaluation'])].sort(),
      );
      await setSetting(market, 'ai-cap-evaluation-month', '0');
    });
  });
});
