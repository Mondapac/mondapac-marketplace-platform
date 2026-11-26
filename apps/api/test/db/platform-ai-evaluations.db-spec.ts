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
import {
  AI_GATEWAY_CONTROLS,
  type AiGatewayControls,
} from '../../src/platform/ai/gateway-controls';
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
const INSUFFICIENT_PRIVILEGE = '42501';
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
  /** The Market's evaluation month cap, micro-dollars (the setting's default 0: closed). */
  let evaluationMonth = 0;
  afterEach(() => {
    evaluationMonth = 0;
  });
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
    // The real settings reader still answers each read (a failing store still closes), but what
    // the close rule and the evaluation budget depend on is pinned by the test: the stop off, no
    // Market month cap (no share, so no saver close) and the evaluation month cap below. Other
    // spec files write and delete the AU and ZZ settings rows in parallel (settings-core deletes
    // them before each of its tests; the usage spec switches the stop on for a moment), so this
    // spec writes no settings row and reads none of theirs.
    const controls = app.get<AiGatewayControls>(AI_GATEWAY_CONTROLS, { strict: false });
    const read = controls.read.bind(controls);
    controls.read = async (context) => {
      const real = await read(context);
      return {
        ...real,
        stopped: false,
        caps: { ...real.caps, marketMonth: null, evaluationMonth },
      };
    };
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

    /** A queued run claimed now with a fresh token. */
    const claimed = async () => {
      const run = newRun(family());
      await write(market, () => store.enqueue(market, run));
      const token = uuid();
      const now = clock.now();
      expect(
        await write(market, () => store.claim(market, run.id, token, now, now.add(LEASE))),
      ).toBe(true);
      return { run, token };
    };
    const CAPABILITY = 'catalog.description-writer.admin';

    it('inserts a sample once and sets a verdict only while pending, with the lease', async () => {
      const { run, token } = await claimed();
      expect(
        await write(market, () => store.addSample(market, run.id, token, sample('plain'))),
      ).toBe(true);
      expect(
        await write(market, () => store.addSample(market, run.id, token, sample('plain'))),
      ).toBe(true);
      expect(await write(market, () => store.samplesOf(market, run.id))).toHaveLength(1);
      expect(
        await write(market, () => store.setVerdict(market, run.id, token, CAPABILITY, 'failed')),
      ).toBe(true);
      await write(market, () =>
        store.setVerdict(market, run.id, token, CAPABILITY, 'pass-candidate'),
      );
      expect(
        (await write(market, () => store.capabilitiesOf(market, run.id))).map((r) => r.verdict),
      ).toEqual(['failed']);
      await write(market, () => store.cancel(market, run.id, clock.now()));
    });

    it('refuses a result of a job that lost its lease: cancelled, or taken over (Mojtaba 1)', async () => {
      const cancelled = await claimed();
      await write(market, () => store.cancel(market, cancelled.run.id, clock.now()));
      const taken = await claimed();
      const later = clock.now().add(LEASE).add({ seconds: 1 });
      const other = uuid();
      expect(
        await write(market, () =>
          store.claim(market, taken.run.id, other, later, later.add(LEASE)),
        ),
      ).toBe(true);
      for (const { run, token } of [cancelled, taken]) {
        expect(
          await write(market, () => store.addSample(market, run.id, token, sample('plain'))),
        ).toBe(false);
        expect(
          await write(market, () => store.setVerdict(market, run.id, token, CAPABILITY, 'failed')),
        ).toBe(false);
        expect(await write(market, () => store.samplesOf(market, run.id))).toEqual([]);
        expect(
          (await write(market, () => store.capabilitiesOf(market, run.id))).map((r) => r.verdict),
        ).toEqual(['pending']);
      }
      // The job holding the run now still writes; the ended run's pending verdicts close.
      expect(
        await write(market, () => store.addSample(market, taken.run.id, other, sample('plain'))),
      ).toBe(true);
      await write(market, () => store.closePending(market, cancelled.run.id));
      await write(market, () => store.closePending(market, taken.run.id));
      expect(
        (await write(market, () => store.capabilitiesOf(market, cancelled.run.id))).map(
          (r) => r.verdict,
        ),
      ).toEqual(['incomplete']);
      expect(
        (await write(market, () => store.capabilitiesOf(market, taken.run.id))).map(
          (r) => r.verdict,
        ),
      ).toEqual(['pending']);
      await write(market, () => store.cancel(market, taken.run.id, later));
    });

    it("keeps a run's life consistent and updates only the granted columns (Mojtaba 2, 4)", async () => {
      const run = newRun(family());
      await write(market, () => store.enqueue(market, run));
      const where = 'WHERE market_id = $1 AND id = $2';
      for (const change of [
        'ended_at = now()',
        `lease_token = '${uuid()}', lease_until = now()`,
        "status = 'cancelled'",
      ]) {
        await expect(
          sql.query(`UPDATE platform.ai_evaluation_runs SET ${change} ${where}`, [code, run.id]),
        ).rejects.toMatchObject({ code: CHECK_VIOLATION });
      }
      await expect(
        sql.query(`UPDATE platform.ai_evaluation_runs SET family = 'other' ${where}`, [
          code,
          run.id,
        ]),
      ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
      await expect(
        sql.query(
          `INSERT INTO platform.ai_evaluation_samples
             (market_id, tenant_id, run_id, capability, sample_id, outcome, checks, call_id,
              route, attempt, input_tokens, output_tokens, cost_micro_usd, finished_at)
           VALUES ($1, $2, $3, $4, 'plain', 'ok', '{}', $5, NULL, NULL, 0, 0, 0, now())`,
          [code, PLATFORM_TENANT_ID, run.id, CAPABILITY, uuid()],
        ),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
      await write(market, () => store.cancel(market, run.id, clock.now()));
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
      const token = uuid();
      await write(market, () => store.claim(market, ended.id, token, old, old.add(LEASE)));
      await write(market, () => store.addSample(market, ended.id, token, sample('plain')));
      await write(market, () => store.cancel(market, ended.id, old.add({ seconds: 1 })));
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
      const token = uuid();
      const now = clock.now();
      await write(market, () => store.claim(market, run.id, token, now, now.add(LEASE)));
      await expect(
        write(market, () =>
          store.addSample(market, run.id, token, { ...sample('plain'), checks: ['nice' as never] }),
        ),
      ).rejects.toThrow();
      await write(market, () => store.cancel(market, run.id, clock.now()));
    });

    it('works a queued run end to end with catalog suites, on the evaluation budget only', async () => {
      evaluationMonth = 100_000_000;
      const context = testCallContext(market, 'system');
      const estimate = await control.estimate(context, 'anthropic', 'model-fast');
      expect(estimate.blockers).toEqual([]);
      expect(estimate.capabilities.length).toBeGreaterThan(0);
      const runId = await write(market, () => control.enqueue(market, estimate, uuid()));
      expect(runId).not.toBeNull();
      const spentOnEvaluation = async () => {
        const rows = await sql.query<{ spent: string }>(
          `SELECT COALESCE(SUM(spent_micro_usd), 0) AS spent FROM platform.ai_budget_counters
            WHERE market_id = $1 AND scope = 'evaluation'`,
          [code],
        );
        return Number(rows.rows[0]!.spent);
      };
      const before = await spentOnEvaluation();
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
      // The evaluation line took exactly the run's cost. Other test files write this Market's
      // other counters at the same time, so the "no other line" rule is proved in the gateway's
      // unit tests, not here.
      const runCost = detail!.samples.reduce((sum, item) => sum + item.costMicroUsd, 0);
      expect((await spentOnEvaluation()) - before).toBe(runCost);
    });
  });
});
