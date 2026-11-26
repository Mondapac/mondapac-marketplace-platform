import { randomBytes } from 'node:crypto';
import { devNull } from 'node:os';
import type { INestApplicationContext } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import pino from 'pino';
import { Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { AppModule } from '../../src/app.module';
import { AiGateway } from '../../src/platform/ai/ai-gateway';
import {
  MODEL_PROVIDER,
  ModelProviderError,
  type ModelProvider,
  type ModelRequest,
} from '../../src/platform/ai/model-provider';
import { AiUsage, type SettledCall, type UsageScope } from '../../src/platform/ai/usage/ai-usage';
import {
  AI_USAGE_STORE,
  CALL_OUTCOMES,
  type AiUsageStore,
} from '../../src/platform/ai/usage/ai-usage-store';
import { AI_EVALUATION_USAGE } from '../../src/platform/ai/usage/ai-usage';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import { ok } from '@mondapac/shared-kernel';
import { CLOCK } from '../../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../../src/platform/market-context/tenant';
import { testAppConfig, TEST_MARKETS } from '../support/test-config';
import { passesFor, testRouteCatalogue } from '../support/ai-routes';
import { AI_ROUTE_CATALOGUE } from '../../src/platform/ai/catalogue/route-catalogue';
import { AI_EVALUATION_RESULTS } from '../../src/platform/ai/evaluations/evaluation-results';
import { CATALOG_AI_CAPABILITIES } from '../../src/modules/catalog/contracts/ai-capabilities';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';
import {
  capsOfBudget,
  listsOf,
  switchesOnBut,
  type TestBudget,
} from '../support/ai-gateway-controls';
import {
  AI_GATEWAY_CONTROLS,
  NO_CAPS,
  NO_MODEL_LISTS,
  type AiCaps,
  type AiGatewayControls,
  type AiModelLists,
} from '../../src/platform/ai/gateway-controls';

// AI Gateway G2 (docs/design/domain/platform-ai.md sections 7 and 10): the usage and budget
// tables in a real database. Concurrent reservations never pass a cap, a settle counts once, the
// day row without a seller is one row (NULLS NOT DISTINCT), the sweeper and the retention job, the
// CHECKs and the grants, and the gateway end to end with a fake provider. Both Market fixtures.

const INSUFFICIENT_PRIVILEGE = '42501';
const CHECK_VIOLATION = '23514';
const NOW = Temporal.Instant.from('2026-11-25T02:00:00Z');

const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);
const uuid = () => uuidV7(Date.now(), randomBytes(10));

const REQUEST: ModelRequest = {
  system: 'You write.',
  messages: [{ role: 'user', blocks: [{ type: 'text', text: 'Write for me, a@b.co' }] }],
  tools: [],
  maxOutputTokens: 100,
};

const settled = (cost: number): SettledCall => ({
  occurredAt: NOW,
  provider: 'anthropic',
  model: 'model-fast',
  attempt: 1,
  fallback: false,
  inputTokens: 10,
  outputTokens: 5,
  inputPicoUsd: 1_000_000,
  outputPicoUsd: 5_000_000,
  costMicroUsd: cost,
  latencyMs: 700,
  outcome: 'ok',
  shadow: false,
  outputCheck: null,
});

async function sqlStateOf(client: Client, statement: string, values: unknown[] = []) {
  await client.query('BEGIN');
  try {
    await client.query(statement, values);
    return 'ok';
  } catch (error) {
    return (error as { code?: string }).code ?? 'unknown';
  } finally {
    await client.query('ROLLBACK');
  }
}

function adminContext(market: MarketContext): CallContext {
  return testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'admin',
      accountId: uuid() as Id<'Account'>,
      sessionId: uuid() as Id<'Session'>,
      sellerId: null,
    }),
  );
}

describe('platform AI usage and budget (database integration, AI Gateway G2)', () => {
  const clock = new FixedClock(NOW);
  let app: INestApplicationContext;
  let usage: AiUsage;
  let gateway: AiGateway;
  let sql: Client;
  let owner: Client;
  const warnings: unknown[] = [];
  /**
   * The Market's model lists the gateway sees. The caps and the stop are the real settings reader's
   * answer; the lists are set here, so this spec writes no `ai-models-*` row that the parallel
   * settings spec would wipe or read (the real list read is tested there, G4b).
   */
  let lists: AiModelLists = listsOf('model-fast');
  /**
   * Caps pinned for a case (G4d2), so a case never depends on a settings row surviving the
   * parallel settings spec; null: the real reader's answer.
   */
  let pinnedCaps: AiCaps | null = null;
  const provider: ModelProvider = {
    call: () =>
      Promise.resolve({
        blocks: [{ type: 'text', text: 'Hello' }],
        stop: 'end',
        usage: { inputTokens: 100, outputTokens: 20 },
      }),
  };

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
      warnings.push(message);
    });
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.register({
          config: testAppConfig({
            DATABASE_URL: testDatabaseUrl(),
            ASSISTANT_MODEL_API_KEY: 'AU=sk-test-canary-key-0001,ZZ=sk-test-canary-key-0002',
            // Removed in G4d1 and still set here on purpose: the app boots, warns once and never
            // uses it as a model (a task type's models are the Market's list in settings).
            ASSISTANT_MODEL_FAST: 'AU=model-fast,ZZ=model-fast',
            AI_BEDROCK_API_KEY: 'AU=bedrock-test-canary-key-0001,ZZ=bedrock-test-canary-key-0002',
          }),
          logDestination: pino.destination(devNull),
        }),
      ],
    })
      .overrideProvider(CLOCK)
      .useValue(clock)
      .overrideProvider(MODEL_PROVIDER)
      .useValue(provider)
      // Verified test routes and passes: the checked-in catalogue has no verified route yet.
      .overrideProvider(AI_ROUTE_CATALOGUE)
      .useValue(testRouteCatalogue())
      .overrideProvider(AI_EVALUATION_RESULTS)
      .useValue(passesFor(CATALOG_AI_CAPABILITIES))
      .compile();
    app = await moduleRef.init();
    usage = app.get(AiUsage);
    gateway = app.get(AiGateway);
    const controls = app.get<AiGatewayControls>(AI_GATEWAY_CONTROLS, { strict: false });
    const read = controls.read.bind(controls);
    controls.read = async (context) => {
      const real = await read(context);
      // The capability switches pinned on (G4d3): the settings spec writes switch rows in parallel.
      return {
        ...real,
        models: lists,
        caps: pinnedCaps ?? real.caps,
        capabilities: switchesOnBut(),
      };
    };
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await owner.connect();
  });

  afterAll(async () => {
    await owner.end();
    await sql.end();
    await app.close();
    jest.restoreAllMocks();
  });

  /** A fresh capability per case, so cases do not share counters. */
  const scopeOf = (sellerId: string | null = null, guest = false): UsageScope => ({
    capability: `test.cap-${randomBytes(4).toString('hex')}`,
    sellerId,
    guest,
  });

  const counter = async (market: MarketContext, scope: string, key: string, period = 'day') => {
    const { rows } = await sql.query<{ held: string; spent: string }>(
      `SELECT held_micro_usd AS held, spent_micro_usd AS spent FROM platform.ai_budget_counters
        WHERE market_id = $1 AND period = $2 AND scope = $3 AND scope_key = $4`,
      [market.marketId, period, scope, key],
    );
    return rows.map((row) => ({ held: Number(row.held), spent: Number(row.spent) }));
  };

  /** Writes a Market setting as an admin change would (the row only; history is not needed). */
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

  it('boots with the removed tier variable set, naming it in one ai.config.removed warning (G4d1)', () => {
    expect(warnings).toContainEqual(
      expect.objectContaining({ msg: 'ai.config.removed', variables: ['ASSISTANT_MODEL_FAST'] }),
    );
    expect(JSON.stringify(warnings)).not.toContain('AU=model-fast');
  });

  describe.each(TEST_MARKETS)('Market %s', (code) => {
    const market = marketOf(code);
    /** The Market's caps for the next reservations (the AI Gateway settings since G4). */
    let caps: AiCaps = NO_CAPS;
    const withBudget = (budget: TestBudget) => {
      caps = capsOfBudget(budget);
    };
    afterEach(() => {
      caps = NO_CAPS;
      jest.restoreAllMocks();
    });

    it('never lets concurrent reservations pass a cap (one conditional UPDATE per counter)', async () => {
      const scope = scopeOf();
      // Room for exactly 7 reservations of 100 on the capability's day.
      withBudget({ capabilityDayMicroUsd: 700 });
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          usage.reserve(market, scope, caps, 100, Temporal.Duration.from({ minutes: 1 })),
        ),
      );
      expect(results.filter((result) => result !== 'over-budget')).toHaveLength(7);
      expect(await counter(market, 'capability', scope.capability)).toEqual([
        { held: 700, spent: 0 },
      ]);
      // A refused reservation left nothing behind: 7 rows.
      const { rows } = await sql.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM platform.ai_budget_reservations WHERE capability = $1',
        [scope.capability],
      );
      expect(rows[0]!.n).toBe(7);
    });

    it('settles once: a second settle of the same reservation changes nothing', async () => {
      const scope = scopeOf(uuid());
      const reservation = await usage.reserve(
        market,
        scope,
        caps,
        900,
        Temporal.Duration.from({ minutes: 1 }),
      );
      if (reservation === 'over-budget') throw new Error('unexpected');
      await usage.settle(market, reservation, settled(300));
      await usage.settle(market, reservation, settled(300));
      expect(await counter(market, 'capability', scope.capability)).toEqual([
        { held: 300, spent: 300 },
      ]);
      expect(await counter(market, 'seller', scope.sellerId!)).toEqual([{ held: 300, spent: 300 }]);
      const calls = await sql.query<Record<string, unknown>>(
        'SELECT * FROM platform.ai_calls WHERE id = $1',
        [reservation.id],
      );
      expect(calls.rows).toHaveLength(1);
      expect(Object.keys(calls.rows[0]!).sort()).toEqual(
        [
          'attempt',
          'capability',
          'cost_micro_usd',
          'day',
          'guest',
          'id',
          'input_pico_usd',
          'input_tokens',
          'latency_ms',
          'market_id',
          'model',
          'occurred_at',
          'outcome',
          'output_pico_usd',
          'output_tokens',
          'provider',
          'seller_id',
          'tenant_id',
        ].sort(),
      );
    });

    it('keeps one day row per capability without a seller (NULLS NOT DISTINCT), with latency buckets', async () => {
      const scope = scopeOf();
      for (const latencyMs of [300, 1500]) {
        const reservation = await usage.reserve(
          market,
          scope,
          caps,
          50,
          Temporal.Duration.from({ minutes: 1 }),
        );
        if (reservation === 'over-budget') throw new Error('unexpected');
        await usage.settle(market, reservation, { ...settled(40), latencyMs });
      }
      await usage.refused(market, scope);
      const { rows } = await sql.query(
        `SELECT calls, refusals, cost_micro_usd::int AS cost, latency_le_500_ms AS fast,
                latency_le_2000_ms AS slower FROM platform.ai_usage_days WHERE capability = $1`,
        [scope.capability],
      );
      expect(rows).toEqual([{ calls: 2, refusals: 1, cost: 80, fast: 1, slower: 1 }]);
    });

    it('counts an expired reservation as spent once (the sweeper), and a late settle counts nothing twice', async () => {
      const scope = scopeOf();
      const reservation = await usage.reserve(
        market,
        scope,
        caps,
        500,
        Temporal.Duration.from({ seconds: 1 }),
      );
      clock.advance(Temporal.Duration.from({ seconds: 2 }));
      if (reservation === 'over-budget') throw new Error('unexpected');
      const [first, second] = await Promise.all([usage.sweep(market), usage.sweep(market)]);
      expect(first.released + second.released).toBeGreaterThanOrEqual(1);
      // The call may have been billed: the whole estimate is spent (Hassan, PR 1348 M2).
      expect(await counter(market, 'capability', scope.capability)).toEqual([
        { held: 500, spent: 500 },
      ]);
      await usage.settle(market, reservation, settled(120));
      expect(await counter(market, 'capability', scope.capability)).toEqual([
        { held: 500, spent: 500 },
      ]);
      const { rows } = await sql.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM platform.ai_calls WHERE id = $1',
        [reservation.id],
      );
      expect(rows[0]!.n).toBe(1);
    });

    it('purges calls older than 90 days in batches, and keeps younger ones', async () => {
      const capability = scopeOf().capability;
      const old = uuid();
      const young = uuid();
      for (const [id, days] of [
        [old, 91],
        [young, 89],
      ] as const) {
        await owner.query(
          `INSERT INTO platform.ai_calls (id, market_id, tenant_id, occurred_at, day, capability,
             seller_id, guest, provider, model, attempt, input_tokens, output_tokens,
             input_pico_usd, output_pico_usd, cost_micro_usd, latency_ms, outcome)
           VALUES ($1, $2, $3, $4, $5, $6, NULL, false, 'anthropic', 'm', 1, 1, 1, 1, 1, 1, 1, 'ok')`,
          [
            id,
            market.marketId,
            market.tenantId,
            new Date(NOW.epochMilliseconds - days * 86_400_000),
            new Date(NOW.epochMilliseconds - days * 86_400_000).toISOString().slice(0, 10),
            capability,
          ],
        );
      }
      const report = await usage.purge(market);
      expect(report.calls).toBeGreaterThanOrEqual(1);
      const { rows } = await sql.query('SELECT id FROM platform.ai_calls WHERE capability = $1', [
        capability,
      ]);
      expect(rows.map((row: { id: string }) => row.id)).toEqual([young]);
    });

    it('reads 30 days of calls per model and day-row tokens per capability, leaving evaluation and older rows out (G5e)', async () => {
      const store = app.get<AiUsageStore>(AI_USAGE_STORE, { strict: false });
      const unit = app.get<UnitOfWork>(UNIT_OF_WORK, { strict: false });
      // A model and capability of this case only: parallel cases write calls of their own.
      const model = `m-${randomBytes(4).toString('hex')}`;
      const capability = scopeOf().capability;
      const insertCall = (
        at: Date,
        values: {
          capability?: string;
          attempt?: number;
          latency?: number;
          outcome?: string;
          cost?: number;
          shadow?: boolean;
        },
      ) =>
        owner.query(
          `INSERT INTO platform.ai_calls (id, market_id, tenant_id, occurred_at, day, capability,
             seller_id, guest, provider, model, attempt, input_tokens, output_tokens,
             input_pico_usd, output_pico_usd, cost_micro_usd, latency_ms, outcome, shadow)
           VALUES ($1, $2, $3, $4, $5, $6, NULL, false, 'anthropic', $7, $8, 1, 1, 1, 1, $9, $10, $11, $12)`,
          [
            uuid(),
            market.marketId,
            market.tenantId,
            at,
            at.toISOString().slice(0, 10),
            values.capability ?? capability,
            model,
            values.attempt ?? 1,
            values.cost ?? 100,
            values.latency ?? 400,
            values.outcome ?? 'ok',
            values.shadow ?? false,
          ],
        );
      const recent = new Date(NOW.epochMilliseconds - 3_600_000);
      await insertCall(recent, {});
      await insertCall(recent, { attempt: 2, latency: 1500, outcome: 'timeout', cost: 50 });
      await insertCall(recent, { latency: 40_000 });
      await insertCall(recent, { capability: AI_EVALUATION_USAGE, cost: 99_999 });
      // A shadow call (G6c) answered no one: left out of the served calls.
      await insertCall(recent, { shadow: true, cost: 99_999 });
      await insertCall(new Date(NOW.epochMilliseconds - 31 * 86_400_000), { cost: 99_999 });

      const day = NOW.toZonedDateTimeISO('UTC').toPlainDate();
      for (const [rowDay, rowCapability, tokens] of [
        [day, capability, 1000],
        [day.subtract({ days: 29 }), capability, 500],
        [day.subtract({ days: 30 }), capability, 99_999],
      ] as const) {
        await owner.query(
          `INSERT INTO platform.ai_usage_days (id, market_id, tenant_id, day, capability, seller_id,
             calls, input_tokens, output_tokens)
           VALUES ($1, $2, $3, $4, $5, NULL, 2, $6, $7)`,
          [
            uuid(),
            market.marketId,
            market.tenantId,
            rowDay.toString(),
            rowCapability,
            tokens,
            tokens * 2,
          ],
        );
      }

      const read = await unit.run(
        market,
        async () =>
          ok({
            calls: await store.callTotalsByModel(
              market,
              Temporal.Instant.fromEpochMilliseconds(NOW.epochMilliseconds - 30 * 86_400_000),
              NOW,
              AI_EVALUATION_USAGE,
            ),
            tokens: await store.tokenTotalsByCapability(
              market,
              day.subtract({ days: 29 }),
              day,
              AI_EVALUATION_USAGE,
            ),
          }),
        { readOnly: true },
      );
      if (!read.ok) throw new Error('read failed');
      expect(read.value.calls.filter((row) => row.model === model)).toEqual([
        {
          provider: 'anthropic',
          model,
          calls: 3,
          failures: 1,
          laterAttempts: 1,
          costMicroUsd: 250,
          // At most 500, 1000, 2000, ... 32000 ms: the 40 s call is above every bound.
          atMostMs: [1, 1, 2, 2, 2, 2, 2],
        },
      ]);
      expect(read.value.tokens.filter((row) => row.capability === capability)).toEqual([
        { capability, calls: 4, inputTokens: 1500, outputTokens: 3000 },
      ]);
      expect(read.value.tokens.some((row) => row.capability === AI_EVALUATION_USAGE)).toBe(false);
    });

    it('runs the gateway end to end: counts the call with no text, then refuses at a full cap without calling', async () => {
      const context = adminContext(market);
      const run = await gateway.run('catalog.description-writer.admin', context, REQUEST, {});
      expect(run).toMatchObject({ ok: true });
      const { rows } = await sql.query(
        `SELECT * FROM platform.ai_calls WHERE market_id = $1 AND capability = 'catalog.description-writer.admin'`,
        [market.marketId],
      );
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(rows)).not.toMatch(/Write for me|Hello|a@b\.co/u);

      // The cap is the settings module's AI Gateway setting (G4), read by the gateway on each call.
      await setSetting(market, 'ai-cap-market-day', '1');
      try {
        const spy = jest.spyOn(provider, 'call');
        expect(await gateway.status('catalog.description-writer.admin', context, {})).toEqual({
          on: false,
          reason: 'over-budget',
        });
        expect(await gateway.run('catalog.description-writer.admin', context, REQUEST, {})).toEqual(
          { ok: false, reason: 'over-budget', costMicroUsd: 0 },
        );
        expect(spy).not.toHaveBeenCalled();
      } finally {
        await setSetting(market, 'ai-cap-market-day', 'none');
      }
    });

    it("holds a capability's own day and month caps at reservation, the month in the Market's month (G4d2)", async () => {
      const scope = scopeOf();
      withBudget({ capabilities: { [scope.capability]: { day: 1000, month: 1500 } } });
      const first = await usage.reserve(
        market,
        scope,
        caps,
        600,
        Temporal.Duration.from({ minutes: 1 }),
      );
      if (first === 'over-budget') throw new Error('unexpected');
      const held = await sql.query<{ capability_month: boolean }>(
        'SELECT capability_month FROM platform.ai_budget_reservations WHERE id = $1',
        [first.id],
      );
      expect(held.rows).toEqual([{ capability_month: true }]);
      await usage.settle(market, first, settled(600));
      expect(
        await usage.reserve(market, scope, caps, 600, Temporal.Duration.from({ minutes: 1 })),
      ).toBe('over-budget');
      const second = await usage.reserve(
        market,
        scope,
        caps,
        400,
        Temporal.Duration.from({ minutes: 1 }),
      );
      if (second === 'over-budget') throw new Error('unexpected');
      await usage.settle(market, second, settled(400));
      expect(await counter(market, 'capability', scope.capability)).toEqual([
        { held: 1000, spent: 1000 },
      ]);
      expect(await counter(market, 'capability', scope.capability, 'month')).toEqual([
        { held: 1000, spent: 1000 },
      ]);
      const month = await sql.query<{ start: string }>(
        `SELECT period_start::text AS start FROM platform.ai_budget_counters
          WHERE market_id = $1 AND period = 'month' AND scope = 'capability' AND scope_key = $2`,
        [market.marketId, scope.capability],
      );
      expect(month.rows).toEqual([
        { start: usage.dayOf(market, clock.now()).with({ day: 1 }).toString() },
      ]);
      expect(await usage.capabilityCapFull(market, scope.capability, caps, 1)).toBe('day');
    });

    it("answers the buyer chat's cap through the gateway: the settings' defaults, then a full day or month (G4d2)", async () => {
      const guest = testCallContext(market, 'anonymous');
      // No row: the defaults (the assistant's former 1000 and 20000 cents).
      const controls = app.get<AiGatewayControls>(AI_GATEWAY_CONTROLS, { strict: false });
      expect((await controls.read(guest)).caps.capabilities['assistant.buyer-chat']).toEqual({
        day: 10_000_000,
        month: 200_000_000,
      });
      try {
        pinnedCaps = capsOfBudget({
          capabilities: { 'assistant.buyer-chat': { day: 0, month: null } },
        });
        // The buyer chat has no recorded evaluation pass here, so it has no route (status
        // no-route); the cap answer is read all the same (a 0 cap is full at any price).
        expect(await gateway.capabilityCapReached('assistant.buyer-chat', guest)).toBe('day');
        pinnedCaps = capsOfBudget({
          capabilities: { 'assistant.buyer-chat': { day: null, month: 0 } },
        });
        expect(await gateway.capabilityCapReached('assistant.buyer-chat', guest)).toBe('month');
        pinnedCaps = capsOfBudget({});
        expect(await gateway.capabilityCapReached('assistant.buyer-chat', guest)).toBeNull();
      } finally {
        pinnedCaps = null;
      }
    });

    it('is off (no-route) without a list for the task type, even with the old tier variable set (G4d1, R8)', async () => {
      const context = adminContext(market);
      lists = NO_MODEL_LISTS;
      try {
        const spy = jest.spyOn(provider, 'call');
        expect(await gateway.status('catalog.description-writer.admin', context, {})).toEqual({
          on: false,
          reason: 'no-route',
        });
        expect(await gateway.run('catalog.description-writer.admin', context, REQUEST, {})).toEqual(
          { ok: false, reason: 'off', costMicroUsd: 0 },
        );
        expect(spy).not.toHaveBeenCalled();
      } finally {
        lists = listsOf('model-fast');
      }
    });

    it('answers emergency-stop while the Market stops AI in its gateway settings (G4)', async () => {
      const context = adminContext(market);
      await setSetting(market, 'ai-gateway-emergency-stop', 'on');
      try {
        const spy = jest.spyOn(provider, 'call');
        expect(await gateway.status('catalog.description-writer.admin', context, {})).toEqual({
          on: false,
          reason: 'emergency-stop',
        });
        expect(await gateway.run('catalog.description-writer.admin', context, REQUEST, {})).toEqual(
          { ok: false, reason: 'off', costMicroUsd: 0 },
        );
        expect(spy).not.toHaveBeenCalled();
      } finally {
        await setSetting(market, 'ai-gateway-emergency-stop', 'off');
      }
    });

    it('falls back to the second route: two call rows, one fallback counted (G3)', async () => {
      const context = adminContext(market);
      // Tests share the day rows: the count must rise by exactly one (Mojtaba, G3 review nit 5).
      const fallbacks = async () =>
        Number(
          (
            await sql.query<{ total: string | null }>(
              `SELECT SUM(fallbacks) AS total FROM platform.ai_usage_days
                WHERE market_id = $1 AND capability = 'catalog.description-writer.admin'`,
              [market.marketId],
            )
          ).rows[0]!.total ?? 0,
        );
      const before = await fallbacks();
      const call = jest.spyOn(provider, 'call').mockImplementation((credentials) =>
        credentials.route === 'anthropic-api'
          ? Promise.reject(new ModelProviderError('server'))
          : Promise.resolve({
              blocks: [{ type: 'text', text: 'Hello' }],
              stop: 'end',
              usage: { inputTokens: 100, outputTokens: 20 },
            }),
      );
      const run = await gateway.run('catalog.description-writer.admin', context, REQUEST, {});
      expect(run).toMatchObject({ ok: true, route: { route: 'bedrock-mantle', attempt: 2 } });
      expect(call).toHaveBeenCalledTimes(2);
      const { rows } = await sql.query<{ attempt: number; outcome: string; model: string }>(
        `SELECT attempt, outcome, model FROM platform.ai_calls
          WHERE market_id = $1 AND capability = 'catalog.description-writer.admin'
            AND (attempt = 2 OR outcome = 'unavailable')
          ORDER BY attempt DESC`,
        [market.marketId],
      );
      expect(rows.map((row) => [row.attempt, row.outcome, row.model])).toEqual([
        [2, 'ok', 'anthropic.model-fast'],
        [1, 'unavailable', 'model-fast'],
      ]);
      expect(await fallbacks()).toBe(before + 1);
    });
  });

  it("keeps each Market's counters, reservations and calls to itself (cross-Market canary, Hassan L5)", async () => {
    const [au, zz] = [marketOf('AU'), marketOf('ZZ')];
    const sellerId = uuid();
    const scope = scopeOf(sellerId);
    const caps = capsOfBudget({ sellerDayMicroUsd: 100 });
    try {
      // The same capability and seller key fill the seller's cap in AU only.
      expect(
        await usage.reserve(au, scope, caps, 100, Temporal.Duration.from({ seconds: 1 })),
      ).not.toBe('over-budget');
      expect(
        await usage.reserve(au, scope, caps, 100, Temporal.Duration.from({ seconds: 1 })),
      ).toBe('over-budget');
      expect(await usage.overBudget(zz, scope, caps)).toBe(false);
      expect(
        await usage.reserve(zz, scope, caps, 100, Temporal.Duration.from({ seconds: 1 })),
      ).not.toBe('over-budget');
      clock.advance(Temporal.Duration.from({ seconds: 2 }));
      // AU's sweeper ends AU's reservation and never touches ZZ's.
      await usage.sweep(au);
      const reservations = async (market: MarketContext) =>
        (
          await sql.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM platform.ai_budget_reservations
              WHERE market_id = $1 AND capability = $2`,
            [market.marketId, scope.capability],
          )
        ).rows[0]!.n;
      expect(await reservations(au)).toBe(0);
      expect(await reservations(zz)).toBe(1);
      expect(await counter(zz, 'seller', sellerId)).toEqual([{ held: 100, spent: 0 }]);
      await usage.sweep(zz);
      expect(await reservations(zz)).toBe(0);

      // AU's retention never deletes ZZ's old call.
      const old = uuid();
      const at = new Date(NOW.epochMilliseconds - 91 * 86_400_000);
      await owner.query(
        `INSERT INTO platform.ai_calls (id, market_id, tenant_id, occurred_at, day, capability,
           seller_id, guest, provider, model, attempt, input_tokens, output_tokens,
           input_pico_usd, output_pico_usd, cost_micro_usd, latency_ms, outcome)
         VALUES ($1, $2, $3, $4, $5, $6, NULL, false, 'anthropic', 'm', 1, 1, 1, 1, 1, 1, 1, 'ok')`,
        [old, zz.marketId, zz.tenantId, at, at.toISOString().slice(0, 10), scope.capability],
      );
      await usage.purge(au);
      const kept = await sql.query('SELECT id FROM platform.ai_calls WHERE id = $1', [old]);
      expect(kept.rows).toHaveLength(1);
      await usage.purge(zz);
      const gone = await sql.query('SELECT id FROM platform.ai_calls WHERE id = $1', [old]);
      expect(gone.rows).toHaveLength(0);
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('grants the application only what the store runs, and the CHECKs hold', async () => {
    const market = marketOf('AU');
    // Calls and reservations are never changed.
    expect(await sqlStateOf(sql, 'UPDATE platform.ai_calls SET cost_micro_usd = 0')).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    expect(
      await sqlStateOf(sql, 'UPDATE platform.ai_budget_reservations SET estimate_micro_usd = 0'),
    ).toBe(INSUFFICIENT_PRIVILEGE);
    expect(await sqlStateOf(sql, 'TRUNCATE platform.ai_budget_counters')).toBe(
      INSUFFICIENT_PRIVILEGE,
    );
    // Held never drops below spent; a month starts on the first; a seller key is a UUID.
    const insert = `INSERT INTO platform.ai_budget_counters
      (market_id, tenant_id, period, period_start, scope, scope_key, held_micro_usd, spent_micro_usd)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;
    const base = [market.marketId, market.tenantId];
    expect(await sqlStateOf(sql, insert, [...base, 'day', '2026-11-25', 'market', '', 1, 2])).toBe(
      CHECK_VIOLATION,
    );
    expect(
      await sqlStateOf(sql, insert, [...base, 'month', '2026-11-25', 'market', '', 0, 0]),
    ).toBe(CHECK_VIOLATION);
    expect(await sqlStateOf(sql, insert, [...base, 'day', '2026-11-25', 'seller', 'x', 0, 0])).toBe(
      CHECK_VIOLATION,
    );
    expect(await sqlStateOf(sql, insert, [...base, 'day', '2020-01-01', 'market', '', 0, 0])).toBe(
      'ok',
    );
    // The widened outcome CHECK (G3): the five outcomes and nothing else.
    const call = `INSERT INTO platform.ai_calls (id, market_id, tenant_id, occurred_at, day,
        capability, seller_id, guest, provider, model, attempt, input_tokens, output_tokens,
        input_pico_usd, output_pico_usd, cost_micro_usd, latency_ms, outcome)
      VALUES ($1, $2, $3, now(), '2026-11-25', 'test.x', NULL, false, 'anthropic', 'm', 2,
        0, 0, 1, 1, 0, 1, $4)`;
    for (const outcome of CALL_OUTCOMES) {
      expect(await sqlStateOf(sql, call, [uuid(), ...base, outcome])).toBe('ok');
    }
    expect(await sqlStateOf(sql, call, [uuid(), ...base, 'refusal'])).toBe(CHECK_VIOLATION);
    // G6c: a shadow row and the capability's check of an answer, only on an ok call.
    const checked = `INSERT INTO platform.ai_calls (id, market_id, tenant_id, occurred_at, day,
        capability, seller_id, guest, provider, model, attempt, input_tokens, output_tokens,
        input_pico_usd, output_pico_usd, cost_micro_usd, latency_ms, outcome, shadow, output_check)
      VALUES ($1, $2, $3, now(), '2026-11-25', 'test.x', NULL, false, 'mondapac', 'm', 1,
        0, 0, 1, 1, 0, 1, $4, $5, $6)`;
    for (const check of ['valid', 'invalid', 'guard-rejected', null]) {
      expect(await sqlStateOf(sql, checked, [uuid(), ...base, 'ok', true, check])).toBe('ok');
    }
    expect(await sqlStateOf(sql, checked, [uuid(), ...base, 'ok', false, 'valid'])).toBe('ok');
    expect(await sqlStateOf(sql, checked, [uuid(), ...base, 'timeout', true, null])).toBe('ok');
    expect(await sqlStateOf(sql, checked, [uuid(), ...base, 'timeout', true, 'valid'])).toBe(
      CHECK_VIOLATION,
    );
    expect(await sqlStateOf(sql, checked, [uuid(), ...base, 'ok', true, 'text'])).toBe(
      CHECK_VIOLATION,
    );
  });
});
