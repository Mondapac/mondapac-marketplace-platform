import { Logger } from '@nestjs/common';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  inMemoryAiUsage,
  type InMemoryAiUsageStore,
} from '../../../test/support/in-memory-ai-usage';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../test/support/test-config';
import {
  passesFor,
  testRoute,
  testRouteCatalogue,
  testRouter,
} from '../../../test/support/ai-routes';
import type { AppConfig } from '../config/app-config';
import { loadMarketConfigs, type MarketConfig } from '../market-config/market-config';
import { MarketRegistry } from '../market-config/market-registry';
import { AiGateway, costMicroUsd, timeoutUsageOf } from './ai-gateway';
import type { CapabilitySpec } from './capability';
import { CapabilityRegistry } from './capability-registry';
import { ModelGateway } from './model-gateway';
import type { AiRouter } from './routing/ai-router';
import {
  ModelProviderError,
  type ModelCredentials,
  type ModelProvider,
  type ModelRequest,
  type ModelTurn,
} from './model-provider';
import { RouteCatalogue, type RouteRow } from './catalogue/route-catalogue';
import { EvaluationResults } from './evaluations/evaluation-results';
import { BREAKER_FAILURES, BREAKER_OPEN_FOR } from './routing/circuit-breaker';
import { MASKED, maskRequest } from './personal-data-masker';
import type { SellerAiSwitch } from './seller-ai-switch';
import type { UnitOfWork } from '../unit-of-work/unit-of-work';
import { SETTLE_ATTEMPTS, type AiUsage } from './usage/ai-usage';

const AU = testMarketContext('AU', 'default');
const ZZ = testMarketContext('ZZ', 'default');
const SELLER = '01938a2b-4123-7456-8abc-0123456789ab' as Id<'Seller'>;
const OTHER_SELLER = '01938a2b-4123-7456-8abc-0123456789ac' as Id<'Seller'>;
const PRICE = { inputPicoUsd: 1_000_000, outputPicoUsd: 5_000_000 };
const TURN: ModelTurn = {
  blocks: [{ type: 'text', text: 'Hello' }],
  stop: 'end',
  usage: { inputTokens: 100, outputTokens: 20 },
};
const REQUEST: ModelRequest = {
  system: 'You write.',
  messages: [{ role: 'user', blocks: [{ type: 'text', text: 'Write for me, a@b.co' }] }],
  tools: [],
  maxOutputTokens: 5000,
};

const base = {
  task: 'write',
  maxInputTokens: 4000,
  maxOutputTokens: 500,
  maxToolRounds: 0,
  timeoutMs: 1000,
  promptVersion: 'p-1',
} as const;
const SPECS: CapabilitySpec[] = [
  { id: 'alpha.seller-writer', audience: 'seller', sellerScoped: true, ...base },
  { id: 'alpha.admin-writer', audience: 'admin', sellerScoped: false, ...base },
  { id: 'alpha.buyer-chat', audience: 'buyer', sellerScoped: false, ...base, task: 'chat' },
  {
    id: 'alpha.tool-chat',
    audience: 'buyer',
    sellerScoped: false,
    ...base,
    task: 'chat',
    maxToolRounds: 2,
  },
];

const NOW = Temporal.Instant.from('2026-11-25T10:00:00Z');
/** The checked-in AU file (no caps: counted only) and the ZZ fixture (caps). */
const REAL_MARKETS = loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS);
const registryOf = (budget?: MarketConfig['aiBudget']) =>
  new MarketRegistry(
    new Map(
      [...REAL_MARKETS].map(([id, config]) => [
        id,
        budget === undefined ? config : { ...config, aiBudget: budget },
      ]),
    ),
  );

// Only AU is configured, on the fast tier: ZZ is a second Market with no model (both fixtures).
const configOf = (killed = false, codes: readonly string[] = ['AU']) =>
  ({
    aiKillSwitch: killed,
    assistantModels: {
      apiKeys: Object.fromEntries(codes.map((code) => [code, 'sk-test-canary-key-0001'])),
      models: {
        fast: Object.fromEntries(codes.map((code) => [code, 'model-fast'])),
        balanced: {},
      },
      bedrockApiKeys: {},
    },
  }) as unknown as AppConfig;

class RecordingProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];
  answer: (signal: AbortSignal) => Promise<ModelTurn> = () => Promise.resolve(TURN);
  call(_credentials: unknown, request: ModelRequest, signal: AbortSignal) {
    this.requests.push(request);
    return this.answer(signal);
  }
}

function sellerContext(market = AU, sellerId: Id<'Seller'> = SELLER): CallContext {
  return testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'seller',
      accountId: '01938a2b-4123-7456-8abc-00000000000a' as Id<'Account'>,
      sessionId: '01938a2b-4123-7456-8abc-00000000000b' as Id<'Session'>,
      sellerId,
    }),
  );
}

function adminContext(market = AU): CallContext {
  return testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'admin',
      accountId: '01938a2b-4123-7456-8abc-00000000000c' as Id<'Account'>,
      sessionId: '01938a2b-4123-7456-8abc-00000000000d' as Id<'Session'>,
      sellerId: null,
    }),
  );
}

describe('AiGateway (platform-ai.md sections 4 and 5; ADR-0019 decision 7, R3, R8)', () => {
  let provider: RecordingProvider;
  let switchedOn: Set<string>;
  let switchThrows: boolean;

  let store: InMemoryAiUsageStore;
  let usage: AiUsage;
  let unitOfWork: UnitOfWork;
  let router: AiRouter;

  const gatewayOf = (killed = false, markets = registryOf(), codes: readonly string[] = ['AU']) => {
    const registry = new CapabilityRegistry();
    registry.register('alpha', SPECS);
    registry.seal();
    const sellerSwitch: SellerAiSwitch = {
      isOn: (_context, sellerId) =>
        switchThrows
          ? Promise.reject(new Error('down'))
          : Promise.resolve(switchedOn.has(sellerId)),
    };
    const clock = new FixedClock(NOW);
    ({ store, usage, unitOfWork } = inMemoryAiUsage(markets, clock));
    const models = new ModelGateway(configOf(killed, codes), provider, testRouteCatalogue());
    router = testRouter(testRouteCatalogue(), passesFor(SPECS), models, markets, clock);
    return new AiGateway(models, registry, sellerSwitch, usage, clock, router);
  };

  beforeEach(() => {
    provider = new RecordingProvider();
    switchedOn = new Set([SELLER]);
    switchThrows = false;
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('runs a seller capability for the seller, masked, with its caps', async () => {
    const run = await gatewayOf().run('alpha.seller-writer', sellerContext(), REQUEST, {
      tier: 'fast',
      sellerId: SELLER,
      timeoutMs: 60_000,
    });
    expect(run).toEqual({
      ok: true,
      turn: TURN,
      route: { provider: 'anthropic', model: 'model-fast', route: 'anthropic-api', attempt: 1 },
      costMicroUsd: 200,
    });
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.maxOutputTokens).toBe(500);
    expect(provider.requests[0]!.messages[0]!.blocks[0]).toEqual({
      type: 'text',
      text: `Write for me, ${MASKED}`,
    });
  });

  it.each([
    ['an unknown capability', 'alpha.nothing', () => sellerContext(), { sellerId: SELLER }],
    ['no seller id', 'alpha.seller-writer', () => sellerContext(), {}],
    [
      'another seller (cross-seller canary)',
      'alpha.seller-writer',
      () => sellerContext(),
      { sellerId: OTHER_SELLER },
    ],
    [
      'an admin calling a seller capability',
      'alpha.seller-writer',
      () => adminContext(),
      { sellerId: SELLER },
    ],
    ['a seller calling an admin capability', 'alpha.admin-writer', () => sellerContext(), {}],
    ['a seller calling the buyer chat', 'alpha.buyer-chat', () => sellerContext(), {}],
  ])('is off for %s and calls nothing', async (_name, capability, context, extra) => {
    const gateway = gatewayOf();
    const options = { tier: 'fast' as const, ...extra };
    expect(await gateway.status(capability, context(), options)).toEqual({
      on: false,
      reason: 'off',
    });
    expect(await gateway.run(capability, context(), REQUEST, options)).toEqual({
      ok: false,
      reason: 'off',
      costMicroUsd: 0,
    });
    expect(provider.requests).toHaveLength(0);
  });

  it('is off in an acting-as session (R3)', async () => {
    const own = sellerContext();
    const actingAs = { ...own, actor: { ...own.actor, actingAs: { adminAccountId: 'x' } } };
    expect(
      await gatewayOf().status('alpha.seller-writer', actingAs as never, {
        tier: 'fast',
        sellerId: SELLER,
      }),
    ).toEqual({ on: false, reason: 'off' });
    expect(
      await gatewayOf().run('alpha.seller-writer', actingAs as never, REQUEST, {
        tier: 'fast',
        sellerId: SELLER,
      }),
    ).toEqual({ ok: false, reason: 'off', costMicroUsd: 0 });
    expect(provider.requests).toHaveLength(0);
  });

  it('turns an unexpected error after the evaluation into unavailable (never throws)', async () => {
    jest.spyOn(ModelGateway.prototype, 'complete').mockRejectedValue(new Error('bug'));
    expect(
      await gatewayOf().run('alpha.admin-writer', adminContext(), REQUEST, { tier: 'fast' }),
    ).toEqual({ ok: false, reason: 'unavailable', costMicroUsd: 0 });
  });

  it("is off when the seller's switch is off or cannot answer (an error is off)", async () => {
    const gateway = gatewayOf();
    switchedOn.clear();
    const options = { tier: 'fast' as const, sellerId: SELLER };
    expect(await gateway.status('alpha.seller-writer', sellerContext(), options)).toEqual({
      on: false,
      reason: 'off',
    });
    switchedOn.add(SELLER);
    switchThrows = true;
    expect(await gateway.run('alpha.seller-writer', sellerContext(), REQUEST, options)).toEqual({
      ok: false,
      reason: 'off',
      costMicroUsd: 0,
    });
    expect(provider.requests).toHaveLength(0);
  });

  it('reports the kill switch, and a Market or tier without a model as no route', async () => {
    expect(
      await gatewayOf(true).status('alpha.admin-writer', adminContext(), { tier: 'fast' }),
    ).toEqual({ on: false, reason: 'kill-switch' });
    const gateway = gatewayOf();
    expect(
      await gateway.status('alpha.admin-writer', adminContext(), { tier: 'balanced' }),
    ).toEqual({ on: false, reason: 'no-route' });
    expect(await gateway.status('alpha.admin-writer', adminContext(ZZ), { tier: 'fast' })).toEqual({
      on: false,
      reason: 'no-route',
    });
    expect(await gateway.status('alpha.admin-writer', adminContext(), { tier: 'fast' })).toEqual({
      on: true,
    });
  });

  it('lets a guest reach the buyer chat', async () => {
    expect(
      await gatewayOf().status('alpha.buyer-chat', testCallContext(AU, 'anonymous'), {
        tier: 'fast',
      }),
    ).toEqual({ on: true });
  });

  it('cuts a call at the shorter timeout and counts the most it can cost', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    provider.answer = (signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(new Error())),
      );
    const run = await gatewayOf().run('alpha.admin-writer', adminContext(), REQUEST, {
      tier: 'fast',
      timeoutMs: 5,
    });
    expect(run).toMatchObject({ ok: false, reason: 'timeout' });
    expect(run.costMicroUsd).toBeGreaterThan(500 * 5);
    // One log line per failed call, with the capability (the model layer logs none).
    expect(warn.mock.calls).toEqual([
      [
        {
          msg: 'ai.run.failed',
          capability: 'alpha.admin-writer',
          marketId: 'AU',
          failure: 'timeout',
          attempts: 1,
        },
      ],
    ]);
  });

  it('turns a provider failure into unavailable at no cost', async () => {
    provider.answer = () => Promise.reject(new Error('provider text with secrets'));
    expect(
      await gatewayOf().run('alpha.admin-writer', adminContext(), REQUEST, { tier: 'fast' }),
    ).toEqual({ ok: false, reason: 'unavailable', costMicroUsd: 0 });
  });

  describe('budget and usage (design sections 5, 7 and 10; G2)', () => {
    const both = ['AU', 'ZZ'] as const;
    const marketOf = (code: string) => (code === 'AU' ? AU : ZZ);
    // 10:00Z is 25 November in both Markets' time zones.
    const dayLine = (scope: 'market' | 'capability' | 'seller' | 'guest', key = '') => ({
      period: 'day' as const,
      periodStart: Temporal.PlainDate.from('2026-11-25'),
      scope,
      scopeKey: key,
    });

    it.each(both)(
      'reserves, settles once with the real cost and records the call (%s)',
      async (c) => {
        const market = marketOf(c);
        const gateway = gatewayOf(false, registryOf(), both);
        const run = await gateway.run('alpha.admin-writer', adminContext(market), REQUEST, {
          tier: 'fast',
        });
        expect(run).toMatchObject({ ok: true, costMicroUsd: 200 });
        expect(store.reservations.size).toBe(0);
        for (const line of [dayLine('market'), dayLine('capability', 'alpha.admin-writer')]) {
          expect(store.counterOf(market, line)).toEqual({ held: 200, spent: 200 });
        }
        expect(store.calls).toEqual([
          expect.objectContaining({
            capability: 'alpha.admin-writer',
            sellerId: null,
            guest: false,
            provider: 'anthropic',
            model: 'model-fast',
            attempt: 1,
            inputTokens: 100,
            outputTokens: 20,
            inputPicoUsd: PRICE.inputPicoUsd,
            outputPicoUsd: PRICE.outputPicoUsd,
            costMicroUsd: 200,
            outcome: 'ok',
          }),
        ]);
        // No text of any kind in the usage row.
        expect(JSON.stringify(store.calls)).not.toMatch(/Write for me|Hello|a@b\.co/u);
        expect(store.usage).toEqual([
          expect.objectContaining({ calls: 1, failures: 0, refusals: 0, costMicroUsd: 200 }),
        ]);
      },
    );

    it.each(both)(
      'is over budget when a cap is full: status says so, run calls nothing and counts a refusal (%s)',
      async (c) => {
        const market = marketOf(c);
        const gateway = gatewayOf(false, registryOf({ capabilityDayMicroUsd: 20_000 }), both);
        store.counters.set(`${market.marketId}|day|2026-11-25|capability|alpha.admin-writer`, {
          held: 20_000,
          spent: 20_000,
        });
        const options = { tier: 'fast' as const };
        expect(await gateway.status('alpha.admin-writer', adminContext(market), options)).toEqual({
          on: false,
          reason: 'over-budget',
        });
        expect(
          await gateway.run('alpha.admin-writer', adminContext(market), REQUEST, options),
        ).toEqual({ ok: false, reason: 'over-budget', costMicroUsd: 0 });
        expect(provider.requests).toHaveLength(0);
        expect(store.reservations.size).toBe(0);
        expect(store.usage).toEqual([expect.objectContaining({ refusals: 1, calls: 0 })]);
        // Another capability of the Market still runs.
        expect(
          await gateway.status('alpha.seller-writer', sellerContext(market), {
            ...options,
            sellerId: SELLER,
          }),
        ).toEqual({ on: true });
      },
    );

    it('refuses a call whose largest cost does not fit the room left, and holds nothing', async () => {
      // The estimate is about 0.4 cents here: a cap with 300 micro-dollars left refuses it.
      const gateway = gatewayOf(false, registryOf({ marketDayMicroUsd: 300 }));
      const run = await gateway.run('alpha.admin-writer', adminContext(), REQUEST, {
        tier: 'fast',
      });
      expect(run).toEqual({ ok: false, reason: 'over-budget', costMicroUsd: 0 });
      expect(provider.requests).toHaveLength(0);
      for (const [, counter] of store.counters) expect(counter.held).toBe(0);
    });

    it('counts a guest on the guest pool and a seller on the seller counter', async () => {
      const gateway = gatewayOf();
      await gateway.run('alpha.buyer-chat', testCallContext(AU, 'anonymous'), REQUEST, {
        tier: 'fast',
      });
      await gateway.run('alpha.seller-writer', sellerContext(), REQUEST, {
        tier: 'fast',
        sellerId: SELLER,
      });
      expect(store.counterOf(AU, dayLine('guest'))).toEqual({ held: 200, spent: 200 });
      expect(store.counterOf(AU, dayLine('seller', SELLER))).toEqual({ held: 200, spent: 200 });
      expect(store.calls.map((call) => [call.guest, call.sellerId])).toEqual([
        [true, null],
        [false, SELLER],
      ]);
    });

    it('settles a timeout at the most it can cost', async () => {
      provider.answer = (signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error())),
        );
      const run = await gatewayOf().run('alpha.admin-writer', adminContext(), REQUEST, {
        tier: 'fast',
        timeoutMs: 5,
      });
      expect(store.counterOf(AU, dayLine('market'))).toEqual({
        held: run.costMicroUsd,
        spent: run.costMicroUsd,
      });
      expect(store.calls[0]).toMatchObject({ outcome: 'timeout', costMicroUsd: run.costMicroUsd });
    });

    it("refuses an input over the capability's maxInputTokens before any call", async () => {
      const big: ModelRequest = {
        ...REQUEST,
        messages: [{ role: 'user', blocks: [{ type: 'text', text: 'x'.repeat(9000) }] }],
      };
      expect(
        await gatewayOf().run('alpha.admin-writer', adminContext(), big, { tier: 'fast' }),
      ).toEqual({ ok: false, reason: 'over-budget', costMicroUsd: 0 });
      expect(provider.requests).toHaveLength(0);
    });

    it('allows maxToolRounds runs per turn, needs a turn id, and sends no tools without rounds', async () => {
      const gateway = gatewayOf();
      const guest = testCallContext(AU, 'anonymous');
      const withTools: ModelRequest = {
        ...REQUEST,
        tools: [{ name: 'search', description: 'Search.', inputSchema: { type: 'object' } }],
      };
      const options = { tier: 'fast' as const, turnId: 'turn-1' };
      expect(await gateway.run('alpha.tool-chat', guest, withTools, options)).toMatchObject({
        ok: true,
      });
      expect(await gateway.run('alpha.tool-chat', guest, withTools, options)).toMatchObject({
        ok: true,
      });
      expect(await gateway.run('alpha.tool-chat', guest, withTools, options)).toEqual({
        ok: false,
        reason: 'over-budget',
        costMicroUsd: 0,
      });
      expect(
        await gateway.run('alpha.tool-chat', guest, withTools, { ...options, turnId: 'turn-2' }),
      ).toMatchObject({ ok: true });
      expect(
        await gateway.run('alpha.tool-chat', guest, withTools, { tier: 'fast' }),
      ).toMatchObject({ ok: false, reason: 'off' });
      expect(
        await gateway.run('alpha.buyer-chat', guest, withTools, { tier: 'fast' }),
      ).toMatchObject({ ok: false, reason: 'off' });
      expect(provider.requests).toHaveLength(3);
    });

    it('is off and calls nothing when the budget cannot be read or written (an error is off)', async () => {
      const gateway = gatewayOf(false, registryOf({ marketDayMicroUsd: 1_000_000 }));
      store.failing = true;
      expect(await gateway.status('alpha.admin-writer', adminContext(), { tier: 'fast' })).toEqual({
        on: false,
        reason: 'off',
      });
      expect(
        await gateway.run('alpha.admin-writer', adminContext(), REQUEST, { tier: 'fast' }),
      ).toEqual({ ok: false, reason: 'off', costMicroUsd: 0 });
      expect(provider.requests).toHaveLength(0);
    });

    it.each([
      ['AU', 'no caps'],
      ['AU', 'caps'],
      ['ZZ', 'no caps'],
      ['ZZ', 'caps'],
    ] as const)(
      'answers off from status called inside an open unit of work (%s, %s; entry condition, Mohammad)',
      async (c, caps) => {
        const market = marketOf(c);
        const gateway = gatewayOf(
          false,
          registryOf(caps === 'caps' ? { marketDayMicroUsd: 1_000_000 } : {}),
          both,
        );
        const inside = await unitOfWork.run(market, async () =>
          ok(await gateway.status('alpha.admin-writer', adminContext(market), { tier: 'fast' })),
        );
        expect(inside).toEqual({ ok: true, value: { on: false, reason: 'off' } });
        // Outside a unit the same call is on.
        expect(
          await gateway.status('alpha.admin-writer', adminContext(market), { tier: 'fast' }),
        ).toEqual({ on: true });
      },
    );

    it.each(both)(
      'is off once a cap cannot take the largest call, and run refuses before any lock when the estimate does not fit (%s; Hassan M1)',
      async (c) => {
        const market = marketOf(c);
        const key = `${market.marketId}|day|2026-11-25|capability|alpha.admin-writer`;
        // The largest call: 8000 input tokens at 1 and 500 output tokens at 5 micro-dollars a
        // thousand, 10,500 micro-dollars. This request's estimate is about 2,600.
        const gateway = gatewayOf(false, registryOf({ capabilityDayMicroUsd: 20_000 }), both);
        const options = { tier: 'fast' as const };
        store.counters.set(key, { held: 9_500, spent: 9_500 });
        expect(await gateway.status('alpha.admin-writer', adminContext(market), options)).toEqual({
          on: true,
        });
        store.counters.set(key, { held: 9_501, spent: 9_501 });
        expect(await gateway.status('alpha.admin-writer', adminContext(market), options)).toEqual({
          on: false,
          reason: 'over-budget',
        });
        // A smaller call still fits the room left.
        expect(
          await gateway.run('alpha.admin-writer', adminContext(market), REQUEST, options),
        ).toMatchObject({ ok: true });
        store.counters.set(key, { held: 19_000, spent: 19_000 });
        const before = new Map(store.counters);
        expect(
          await gateway.run('alpha.admin-writer', adminContext(market), REQUEST, options),
        ).toEqual({ ok: false, reason: 'over-budget', costMicroUsd: 0 });
        expect(provider.requests).toHaveLength(1);
        expect(store.reservations.size).toBe(0);
        // Refused on the read: no counter row was created or written.
        expect(store.counters).toEqual(before);
      },
    );

    it('counts an expired reservation as spent, and a late settle writes the call without counting twice (Hassan M2)', async () => {
      gatewayOf();
      const scope = { capability: 'alpha.admin-writer', sellerId: null, guest: false };
      const reservation = await usage.reserve(
        AU,
        scope,
        900,
        Temporal.Duration.from({ seconds: -1 }),
      );
      expect(store.counterOf(AU, dayLine('market'))).toEqual({ held: 900, spent: 0 });
      expect(await usage.sweep(AU)).toEqual({ released: 1, backlog: false });
      // The call may have been sent and billed: the whole estimate is spent, never released.
      expect(store.counterOf(AU, dayLine('market'))).toEqual({ held: 900, spent: 900 });
      expect(await usage.sweep(AU)).toEqual({ released: 0, backlog: false });
      await usage.settle(AU, reservation as Exclude<typeof reservation, 'over-budget'>, {
        occurredAt: NOW,
        provider: 'anthropic',
        model: 'model-fast',
        attempt: 1,
        fallback: false,
        inputTokens: 10,
        outputTokens: 10,
        inputPicoUsd: 1,
        outputPicoUsd: 1,
        costMicroUsd: 300,
        latencyMs: 10,
        outcome: 'ok',
      });
      expect(store.counterOf(AU, dayLine('market'))).toEqual({ held: 900, spent: 900 });
      expect(store.calls).toHaveLength(1);
      expect(store.usage).toEqual([expect.objectContaining({ calls: 1, costMicroUsd: 300 })]);
    });

    it('retries a failed settle, and one that keeps failing is logged and left to the sweeper (Hassan M2)', async () => {
      gatewayOf();
      const scope = { capability: 'alpha.admin-writer', sellerId: null, guest: false };
      const settled = {
        occurredAt: NOW,
        provider: 'anthropic',
        model: 'model-fast',
        attempt: 1,
        fallback: false,
        inputTokens: 10,
        outputTokens: 10,
        inputPicoUsd: 1,
        outputPicoUsd: 1,
        costMicroUsd: 300,
        latencyMs: 10,
        outcome: 'ok' as const,
      };
      const first = await usage.reserve(AU, scope, 900, Temporal.Duration.from({ seconds: 60 }));
      store.failNext = SETTLE_ATTEMPTS - 1;
      await usage.settle(AU, first as Exclude<typeof first, 'over-budget'>, settled);
      expect(store.counterOf(AU, dayLine('market'))).toEqual({ held: 300, spent: 300 });
      expect(store.reservations.size).toBe(0);

      const second = await usage.reserve(AU, scope, 900, Temporal.Duration.from({ seconds: 60 }));
      store.failNext = SETTLE_ATTEMPTS;
      await usage.settle(AU, second as Exclude<typeof second, 'over-budget'>, settled);
      // Not settled: the estimate stays held until the sweeper counts it as spent.
      expect(store.counterOf(AU, dayLine('market'))).toEqual({ held: 1200, spent: 300 });
      expect(store.reservations.size).toBe(1);
    });

    it('stops a sweep at its run time and reports the backlog (Hassan L4)', async () => {
      gatewayOf();
      const scope = { capability: 'alpha.admin-writer', sellerId: null, guest: false };
      await usage.reserve(AU, scope, 900, Temporal.Duration.from({ seconds: -1 }));
      expect(await usage.sweep(AU, 0)).toEqual({ released: 0, backlog: true });
      expect(await usage.purge(AU, 0)).toEqual({ calls: 0, days: 0, counters: 0, backlog: true });
      expect(await usage.sweep(AU, 1000)).toEqual({ released: 1, backlog: false });
    });
  });

  describe('routing and fallback (design section 6; ADR-0052; G3)', () => {
    const SLOW: CapabilitySpec = {
      id: 'alpha.slow-writer',
      audience: 'admin',
      sellerScoped: false,
      ...base,
      timeoutMs: 3000,
    };
    const ROUTED = [...SPECS, SLOW];
    const PRIMARY = 'anthropic-api/model-fast';
    const FALLBACK = 'bedrock-mantle/anthropic.model-fast';

    /** A provider that answers per route: a function of the route kind. */
    class RouteProvider implements ModelProvider {
      readonly routes: string[] = [];
      answer: (route: string, signal: AbortSignal) => Promise<ModelTurn> = () =>
        Promise.resolve(TURN);
      call(credentials: ModelCredentials, _request: ModelRequest, signal: AbortSignal) {
        this.routes.push(credentials.route);
        return this.answer(credentials.route, signal);
      }
    }

    let routed: RouteProvider;
    let clock: FixedClock;
    const routedGateway = (
      setup: {
        catalogue?: RouteCatalogue;
        passes?: EvaluationResults;
        markets?: MarketRegistry;
        bedrockKey?: boolean;
      } = {},
    ) => {
      const registry = new CapabilityRegistry();
      registry.register('alpha', ROUTED);
      registry.seal();
      const markets = setup.markets ?? registryOf();
      clock = new FixedClock(NOW);
      ({ store, usage, unitOfWork } = inMemoryAiUsage(markets, clock));
      const config = configOf(false, ['AU', 'ZZ']) as unknown as {
        assistantModels: Record<string, unknown>;
      };
      const withBedrock = {
        ...config,
        assistantModels: {
          ...config.assistantModels,
          bedrockApiKeys:
            setup.bedrockKey === false
              ? {}
              : { AU: 'bedrock-test-canary-key-0001', ZZ: 'bedrock-test-canary-key-0002' },
        },
      } as unknown as AppConfig;
      const catalogue = setup.catalogue ?? testRouteCatalogue();
      const models = new ModelGateway(withBedrock, routed, catalogue);
      router = testRouter(catalogue, setup.passes ?? passesFor(ROUTED), models, markets, clock);
      return new AiGateway(
        models,
        registry,
        { isOn: () => Promise.resolve(true) },
        usage,
        clock,
        router,
      );
    };

    beforeEach(() => {
      routed = new RouteProvider();
    });

    it.each(['AU', 'ZZ'] as const)(
      'moves to the second route after a server error, reserving before each attempt (%s)',
      async (code) => {
        const market = code === 'AU' ? AU : ZZ;
        routed.answer = (route) =>
          route === 'anthropic-api'
            ? Promise.reject(new ModelProviderError('server'))
            : Promise.resolve(TURN);
        const gateway = routedGateway();
        const reserve = jest.spyOn(usage, 'reserve');
        const run = await gateway.run('alpha.admin-writer', adminContext(market), REQUEST, {
          tier: 'fast',
        });
        expect(run).toEqual({
          ok: true,
          turn: TURN,
          route: {
            provider: 'anthropic',
            model: 'anthropic.model-fast',
            route: 'bedrock-mantle',
            attempt: 2,
          },
          costMicroUsd: 200,
        });
        expect(routed.routes).toEqual(['anthropic-api', 'bedrock-mantle']);
        expect(reserve).toHaveBeenCalledTimes(2);
        expect(store.reservations.size).toBe(0);
        expect(store.calls.map((call) => [call.attempt, call.model, call.outcome])).toEqual([
          [1, 'model-fast', 'unavailable'],
          [2, 'anthropic.model-fast', 'ok'],
        ]);
        expect(new Set(store.calls.map((call) => call.id)).size).toBe(2);
        expect(store.usage.map((delta) => delta.fallbacks)).toEqual([0, 1]);
      },
    );

    it('moves on a rate limit and on a timeout, never on a refused request', async () => {
      routed.answer = (route) =>
        route === 'anthropic-api'
          ? Promise.reject(new ModelProviderError('rate-limited'))
          : Promise.resolve(TURN);
      expect(
        await routedGateway().run('alpha.admin-writer', adminContext(), REQUEST, { tier: 'fast' }),
      ).toMatchObject({ ok: true, route: { attempt: 2 } });

      routed = new RouteProvider();
      routed.answer = (route, signal) =>
        route === 'anthropic-api'
          ? new Promise((_resolve, reject) =>
              signal.addEventListener('abort', () => reject(new Error())),
            )
          : Promise.resolve(TURN);
      const slow = await routedGateway().run('alpha.slow-writer', adminContext(), REQUEST, {
        tier: 'fast',
      });
      expect(slow).toMatchObject({ ok: true, route: { attempt: 2 } });
      // The timed-out attempt is counted at the most it could cost.
      expect(slow.costMicroUsd).toBeGreaterThan(200 + 500 * 5);
      expect(store.calls.map((call) => call.outcome)).toEqual(['timeout', 'ok']);

      routed = new RouteProvider();
      routed.answer = () => Promise.reject(new ModelProviderError('client'));
      expect(
        await routedGateway().run('alpha.admin-writer', adminContext(), REQUEST, { tier: 'fast' }),
      ).toEqual({ ok: false, reason: 'unavailable', costMicroUsd: 0 });
      expect(routed.routes).toEqual(['anthropic-api']);
      expect(store.calls.map((call) => call.outcome)).toEqual(['rejected']);
    });

    it('answers the last failure when every route fails', async () => {
      routed.answer = (route) =>
        Promise.reject(
          new ModelProviderError(route === 'anthropic-api' ? 'server' : 'rate-limited'),
        );
      expect(
        await routedGateway().run('alpha.admin-writer', adminContext(), REQUEST, { tier: 'fast' }),
      ).toEqual({ ok: false, reason: 'rate-limited', costMicroUsd: 0 });
      expect(routed.routes).toEqual(['anthropic-api', 'bedrock-mantle']);
    });

    it('uses only the route with a key: no Bedrock key, no fallback', async () => {
      routed.answer = () => Promise.reject(new ModelProviderError('server'));
      expect(
        await routedGateway({ bedrockKey: false }).run(
          'alpha.admin-writer',
          adminContext(),
          REQUEST,
          { tier: 'fast' },
        ),
      ).toEqual({ ok: false, reason: 'unavailable', costMicroUsd: 0 });
      expect(routed.routes).toEqual(['anthropic-api']);
    });

    const unusable = (overrides: Partial<RouteRow>) =>
      new RouteCatalogue([
        testRoute('model-fast', 'anthropic-api', overrides),
        testRoute('model-fast', 'bedrock-mantle', overrides),
      ]);
    it.each([
      ['no recorded no-retention check', { catalogue: unusable({ dataTerms: null }) }],
      ['no region', { catalogue: unusable({ region: null }) }],
      ['a region outside the Market', { catalogue: unusable({ region: 'us-east-1' }) }],
      ['a model past its retirement day', { catalogue: unusable({ retiresOn: '2026-11-24' }) }],
      ['no evaluation pass', { passes: new EvaluationResults([]) }],
      [
        'a pass for another prompt version',
        {
          passes: passesFor(ROUTED.map((spec) => ({ ...spec, promptVersion: 'p-0' }))),
        },
      ],
      [
        'a Market whose residency expresses no condition',
        {
          markets: new MarketRegistry(
            new Map(
              [...REAL_MARKETS].map(([id, config]) => [
                id,
                {
                  ...config,
                  aiRouting: { dataResidency: 'none', regions: [], saverAtPercent: 80 },
                },
              ]),
            ) as never,
          ),
        },
      ],
    ])('has no route with %s, and calls nothing', async (_name, setup) => {
      const gateway = routedGateway(setup);
      expect(await gateway.status('alpha.admin-writer', adminContext(), { tier: 'fast' })).toEqual({
        on: false,
        reason: 'no-route',
      });
      expect(
        await gateway.run('alpha.admin-writer', adminContext(), REQUEST, { tier: 'fast' }),
      ).toEqual({ ok: false, reason: 'off', costMicroUsd: 0 });
      expect(routed.routes).toEqual([]);
    });

    it('is usable on its retirement day', async () => {
      const gateway = routedGateway({ catalogue: unusable({ retiresOn: '2026-11-25' }) });
      expect(await gateway.status('alpha.admin-writer', adminContext(), { tier: 'fast' })).toEqual({
        on: true,
      });
    });

    it('sets a failing route aside, goes straight to the fallback, then tries it again', async () => {
      routed.answer = (route) =>
        route === 'anthropic-api'
          ? Promise.reject(new ModelProviderError('server'))
          : Promise.resolve(TURN);
      const gateway = routedGateway();
      for (let index = 0; index < BREAKER_FAILURES; index += 1) {
        await gateway.run('alpha.admin-writer', adminContext(), REQUEST, { tier: 'fast' });
      }
      expect(router.breaker.open('AU', PRIMARY)).toBe(true);
      expect(router.breaker.open('ZZ', PRIMARY)).toBe(false);
      routed.routes.length = 0;
      expect(
        await gateway.run('alpha.admin-writer', adminContext(), REQUEST, { tier: 'fast' }),
      ).toMatchObject({ ok: true, route: { route: 'bedrock-mantle', attempt: 1 } });
      expect(routed.routes).toEqual(['bedrock-mantle']);
      // The route the call used is not the plan's first: it is counted as a fallback.
      expect(store.usage.at(-1)?.fallbacks).toBe(1);

      // After the pause one call tries the route again; a success closes it.
      clock.advance(BREAKER_OPEN_FOR);
      routed.answer = () => Promise.resolve(TURN);
      routed.routes.length = 0;
      expect(
        await gateway.run('alpha.admin-writer', adminContext(), REQUEST, { tier: 'fast' }),
      ).toMatchObject({ ok: true, route: { route: 'anthropic-api' } });
      expect(router.breaker.open('AU', PRIMARY)).toBe(false);
      expect(router.breaker.open('AU', FALLBACK)).toBe(false);
    });

    it('moves on when a route refuses its key or model (401, 403, 404), and counts it', async () => {
      routed.answer = (route) =>
        route === 'anthropic-api'
          ? Promise.reject(new ModelProviderError('route'))
          : Promise.resolve(TURN);
      const gateway = routedGateway();
      expect(
        await gateway.run('alpha.admin-writer', adminContext(), REQUEST, { tier: 'fast' }),
      ).toMatchObject({ ok: true, route: { route: 'bedrock-mantle', attempt: 2 } });
      for (let index = 1; index < BREAKER_FAILURES; index += 1) {
        await gateway.run('alpha.admin-writer', adminContext(), REQUEST, { tier: 'fast' });
      }
      expect(router.breaker.open('AU', PRIMARY)).toBe(true);
    });

    it('never sets a route aside for timeouts (a slow request is not an outage)', async () => {
      routed.answer = (route, signal) =>
        route === 'anthropic-api'
          ? new Promise((_resolve, reject) =>
              signal.addEventListener('abort', () => reject(new Error())),
            )
          : Promise.resolve(TURN);
      const gateway = routedGateway();
      const failed = jest.spyOn(router.breaker, 'failed');
      expect(
        await gateway.run('alpha.slow-writer', adminContext(), REQUEST, { tier: 'fast' }),
      ).toMatchObject({ ok: true, route: { attempt: 2 } });
      expect(failed).not.toHaveBeenCalled();
    });

    it('gives the first route all the time when the fallback is set aside', async () => {
      routed.answer = (route) =>
        route === 'bedrock-mantle'
          ? Promise.reject(new ModelProviderError('server'))
          : Promise.reject(new ModelProviderError('client'));
      const gateway = routedGateway();
      for (let index = 0; index < BREAKER_FAILURES; index += 1) {
        router.breaker.failed('AU', FALLBACK);
      }
      const complete = jest.spyOn(ModelGateway.prototype, 'complete');
      await gateway.run('alpha.slow-writer', adminContext(), REQUEST, { tier: 'fast' });
      expect(complete).toHaveBeenCalledTimes(1);
      // No usable fallback behind it: no share is kept back (Mohammad, G3 review 6).
      expect(complete.mock.calls[0]![3]).toBeGreaterThan(SLOW.timeoutMs * 0.9);
    });

    it('answers unavailable without a call when every route is set aside', async () => {
      routed.answer = () => Promise.reject(new ModelProviderError('server'));
      const gateway = routedGateway();
      for (let index = 0; index < BREAKER_FAILURES; index += 1) {
        await gateway.run('alpha.admin-writer', adminContext(), REQUEST, { tier: 'fast' });
      }
      routed.routes.length = 0;
      expect(
        await gateway.run('alpha.admin-writer', adminContext(), REQUEST, { tier: 'fast' }),
      ).toEqual({ ok: false, reason: 'unavailable', costMicroUsd: 0 });
      expect(routed.routes).toEqual([]);
    });

    it('prices the estimate at the dearest route of the plan', async () => {
      const catalogue = new RouteCatalogue([
        testRoute('model-fast'),
        testRoute('model-fast', 'bedrock-mantle', { inputUsdPerMTok: 2, outputUsdPerMTok: 10 }),
      ]);
      const gateway = routedGateway({ catalogue });
      const reserve = jest.spyOn(usage, 'reserve');
      await gateway.run('alpha.admin-writer', adminContext(), REQUEST, { tier: 'fast' });
      const usageOf = timeoutUsageOf(maskRequest({ ...REQUEST, maxOutputTokens: 500 }));
      expect(reserve.mock.calls[0]![2]).toBe(
        costMicroUsd(usageOf, { inputPicoUsd: 2_000_000, outputPicoUsd: 10_000_000 }),
      );
    });

    describe('saver mode', () => {
      const saverMarkets = () =>
        new MarketRegistry(
          new Map(
            [...REAL_MARKETS].map(([id, config]) => [
              id,
              {
                ...config,
                aiRouting: {
                  dataResidency: 'in-market-region',
                  regions: ['ap-southeast-2'],
                  saverModel: 'model-saver',
                  saverAtPercent: 80,
                },
              },
            ]),
          ) as never,
        );
      const withSaver = (price: number) =>
        testRouteCatalogue([
          testRoute('model-saver', 'anthropic-api', {
            inputUsdPerMTok: price,
            outputUsdPerMTok: price,
          }),
        ]);
      const saverPasses = passesFor(ROUTED, ['model-fast', 'model-saver']);

      it.each([
        [0.85, 'model-saver'],
        [0.5, 'model-fast'],
        [null, 'model-fast'],
      ])('at a month share of %s tries %s first', async (share, first) => {
        const gateway = routedGateway({
          catalogue: withSaver(0.1),
          passes: saverPasses,
          markets: saverMarkets(),
        });
        jest.spyOn(usage, 'monthShare').mockResolvedValue(share);
        expect(
          await gateway.run('alpha.admin-writer', adminContext(), REQUEST, { tier: 'fast' }),
        ).toMatchObject({ ok: true, route: { model: first, attempt: 1 } });
      });

      it('never puts a saver model first that is not cheaper', async () => {
        const gateway = routedGateway({
          catalogue: withSaver(50),
          passes: saverPasses,
          markets: saverMarkets(),
        });
        jest.spyOn(usage, 'monthShare').mockResolvedValue(0.95);
        expect(
          await gateway.run('alpha.admin-writer', adminContext(), REQUEST, { tier: 'fast' }),
        ).toMatchObject({ ok: true, route: { model: 'model-fast' } });
      });

      it('keeps the normal order when the share cannot be read', async () => {
        const gateway = routedGateway({
          catalogue: withSaver(0.1),
          passes: saverPasses,
          markets: saverMarkets(),
        });
        jest.spyOn(usage, 'monthShare').mockRejectedValue(new Error('down'));
        expect(
          await gateway.run('alpha.admin-writer', adminContext(), REQUEST, { tier: 'fast' }),
        ).toMatchObject({ ok: true, route: { model: 'model-fast' } });
      });

      it('reads the month share from the Market month counter (ZZ caps)', async () => {
        routedGateway();
        expect(await usage.monthShare(AU)).toBeNull();
        expect(await usage.monthShare(ZZ)).toBe(0);
      });
    });
  });

  it('shows the setup without the key', () => {
    expect(gatewayOf().setup(AU.marketId)).toEqual({
      killSwitch: false,
      keyConfigured: true,
      models: { fast: 'model-fast', balanced: null },
    });
    expect(JSON.stringify(gatewayOf().setup(AU.marketId))).not.toContain('sk-test');
  });
});
