import { randomBytes } from 'node:crypto';
import { devNull } from 'node:os';
import type { INestApplicationContext } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from 'pg';
import pino from 'pino';
import { Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, MarketId } from '@mondapac/shared-kernel';
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
import { CALL_OUTCOMES } from '../../src/platform/ai/usage/ai-usage-store';
import { CLOCK } from '../../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../../src/platform/market-context/tenant';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { testAppConfig, TEST_MARKETS } from '../support/test-config';
import { passesFor, testRouteCatalogue } from '../support/ai-routes';
import { AI_ROUTE_CATALOGUE } from '../../src/platform/ai/catalogue/route-catalogue';
import { AI_EVALUATION_RESULTS } from '../../src/platform/ai/evaluations/evaluation-results';
import { CATALOG_AI_CAPABILITIES } from '../../src/modules/catalog/contracts/ai-capabilities';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

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
  let markets: MarketRegistry;
  let sql: Client;
  let owner: Client;
  const provider: ModelProvider = {
    call: () =>
      Promise.resolve({
        blocks: [{ type: 'text', text: 'Hello' }],
        stop: 'end',
        usage: { inputTokens: 100, outputTokens: 20 },
      }),
  };

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const moduleRef = await Test.createTestingModule({
      imports: [
        AppModule.register({
          config: testAppConfig({
            DATABASE_URL: testDatabaseUrl(),
            ASSISTANT_MODEL_API_KEY: 'AU=sk-test-canary-key-0001,ZZ=sk-test-canary-key-0002',
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
    markets = app.get(MarketRegistry);
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

  describe.each(TEST_MARKETS)('Market %s', (code) => {
    const market = marketOf(code);
    const original = () => markets.get(market.marketId);
    const withBudget = (aiBudget: Record<string, number>) => {
      const config = original();
      jest
        .spyOn(markets, 'get')
        .mockImplementation((id) =>
          id === market.marketId
            ? { ...config, aiBudget }
            : MarketRegistry.prototype.get.call(markets, id),
        );
    };
    afterEach(() => jest.restoreAllMocks());

    it('never lets concurrent reservations pass a cap (one conditional UPDATE per counter)', async () => {
      const scope = scopeOf();
      // Room for exactly 7 reservations of 100 on the capability's day.
      withBudget({ capabilityDayMicroUsd: 700 });
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          usage.reserve(market, scope, 100, Temporal.Duration.from({ minutes: 1 })),
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

    it('runs the gateway end to end: counts the call with no text, then refuses at a full cap without calling', async () => {
      const context = adminContext(market);
      const run = await gateway.run('catalog.description-writer.admin', context, REQUEST, {
        tier: 'fast',
      });
      expect(run).toMatchObject({ ok: true });
      const { rows } = await sql.query(
        `SELECT * FROM platform.ai_calls WHERE market_id = $1 AND capability = 'catalog.description-writer.admin'`,
        [market.marketId],
      );
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(JSON.stringify(rows)).not.toMatch(/Write for me|Hello|a@b\.co/u);

      withBudget({ marketDayMicroUsd: 1 });
      const spy = jest.spyOn(provider, 'call');
      expect(
        await gateway.status('catalog.description-writer.admin', context, { tier: 'fast' }),
      ).toEqual({ on: false, reason: 'over-budget' });
      expect(
        await gateway.run('catalog.description-writer.admin', context, REQUEST, { tier: 'fast' }),
      ).toEqual({ ok: false, reason: 'over-budget', costMicroUsd: 0 });
      expect(spy).not.toHaveBeenCalled();
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
      const run = await gateway.run('catalog.description-writer.admin', context, REQUEST, {
        tier: 'fast',
      });
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
    const config = (id: MarketId) => MarketRegistry.prototype.get.call(markets, id);
    jest
      .spyOn(markets, 'get')
      .mockImplementation((id) => ({ ...config(id), aiBudget: { sellerDayMicroUsd: 100 } }));
    try {
      // The same capability and seller key fill the seller's cap in AU only.
      expect(await usage.reserve(au, scope, 100, Temporal.Duration.from({ seconds: 1 }))).not.toBe(
        'over-budget',
      );
      expect(await usage.reserve(au, scope, 100, Temporal.Duration.from({ seconds: 1 }))).toBe(
        'over-budget',
      );
      expect(await usage.overBudget(zz, scope)).toBe(false);
      expect(await usage.reserve(zz, scope, 100, Temporal.Duration.from({ seconds: 1 }))).not.toBe(
        'over-budget',
      );
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
  });
});
