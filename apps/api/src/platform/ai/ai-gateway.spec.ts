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
import type { AppConfig } from '../config/app-config';
import { loadMarketConfigs, type MarketConfig } from '../market-config/market-config';
import { MarketRegistry } from '../market-config/market-registry';
import { AiGateway } from './ai-gateway';
import type { CapabilitySpec } from './capability';
import { CapabilityRegistry } from './capability-registry';
import { ModelGateway } from './model-gateway';
import type { ModelProvider, ModelRequest, ModelTurn } from './model-provider';
import { MASKED } from './personal-data-masker';
import type { SellerAiSwitch } from './seller-ai-switch';
import type { UnitOfWork } from '../unit-of-work/unit-of-work';
import type { AiUsage } from './usage/ai-usage';

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
      prices: { fast: Object.fromEntries(codes.map((code) => [code, PRICE])), balanced: {} },
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
    return new AiGateway(
      new ModelGateway(configOf(killed, codes), provider),
      registry,
      sellerSwitch,
      usage,
      clock,
    );
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
      route: { provider: 'anthropic', model: 'model-fast', attempt: 1 },
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
        const gateway = gatewayOf(false, registryOf({ capabilityDayMicroUsd: 1000 }), both);
        store.counters.set(`${market.marketId}|day|2026-11-25|capability|alpha.admin-writer`, {
          held: 1000,
          spent: 1000,
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

    it('answers off from status called inside an open unit of work (entry condition, Mohammad)', async () => {
      const gateway = gatewayOf(false, registryOf({ marketDayMicroUsd: 1_000_000 }));
      const inside = await unitOfWork.run(AU, async () =>
        ok(await gateway.status('alpha.admin-writer', adminContext(), { tier: 'fast' })),
      );
      expect(inside).toEqual({ ok: true, value: { on: false, reason: 'off' } });
    });

    it('releases a reservation the sweeper finds expired, and a late settle still counts the cost', async () => {
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
      expect(store.counterOf(AU, dayLine('market'))).toEqual({ held: 0, spent: 0 });
      expect(await usage.sweep(AU)).toEqual({ released: 0, backlog: false });
      await usage.settle(AU, reservation as Exclude<typeof reservation, 'over-budget'>, {
        occurredAt: NOW,
        provider: 'anthropic',
        model: 'model-fast',
        attempt: 1,
        inputTokens: 10,
        outputTokens: 10,
        inputPicoUsd: 1,
        outputPicoUsd: 1,
        costMicroUsd: 300,
        latencyMs: 10,
        outcome: 'ok',
      });
      expect(store.counterOf(AU, dayLine('market'))).toEqual({ held: 300, spent: 300 });
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
