import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, MarketId } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TestAiGatewayControls } from '../../../../test/support/ai-gateway-controls';
import {
  testInHouseRoute,
  RecordingRollbackNotices,
  testRollback,
  testRouteCatalogue,
  testRouter,
  testRollout,
  testShadow,
} from '../../../../test/support/ai-routes';
import {
  inMemoryAiUsage,
  InMemoryAiUsageUnitOfWork,
  type InMemoryAiUsageStore,
} from '../../../../test/support/in-memory-ai-usage';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AppConfig } from '../../config/app-config';
import { loadMarketConfigs } from '../../market-config/market-config';
import { MarketRegistry } from '../../market-config/market-registry';
import { AiGateway } from '../ai-gateway';
import type { CapabilitySpec } from '../capability';
import { CapabilityRegistry } from '../capability-registry';
import type { RouteRow } from '../catalogue/route-catalogue';
import { EvaluationResults } from '../evaluations/evaluation-results';
import { ModelGateway } from '../model-gateway';
import type { ModelCredentials, ModelProvider, ModelRequest, ModelTurn } from '../model-provider';
import { MASKED } from '../personal-data-masker';
import { MAX_ATTEMPTS, type PlannedRoute } from '../routing/ai-router';
import {
  EvaluationSuiteRegistry,
  type EvaluationSuite,
  type OutputCheck,
} from '../evaluations/evaluation-suite';
import type { CallRecord } from '../usage/ai-usage-store';
import type { InHouseRollback } from './in-house-rollback';
import { InHouseRollbackStatusRead } from './in-house-rollback-status';
import {
  ROLLBACK_JUDGE_EVERY,
  ROLLBACK_READ_FOR,
  ROLLBACK_WINDOW,
  rollbackReason,
} from './in-house-rollback';
import { livePlan, turnBucket } from './in-house-rollout';
import { SERVED_IN_HOUSE_STAGES, type InHouseTaskPage } from './in-house-stage';

// The percent and default stages of the in-house model through the real gateway (AI Gateway G6d2;
// docs/design/domain/platform-ai.md section 8): who the in-house model answers, through which
// routes, what falls back to the external models. Both Market fixtures (AU and ZZ).

const NOW = Temporal.Instant.from('2026-11-27T10:00:00Z');
const MARKETS = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

const base = {
  audience: 'admin',
  sellerScoped: false,
  maxInputTokens: 4000,
  maxOutputTokens: 500,
  maxToolRounds: 0,
  timeoutMs: 1000,
  promptVersion: 'p-1',
} as const;
const WRITER: CapabilitySpec = {
  id: 'alpha.writer',
  task: 'write',
  ...base,
  dataCategories: ['seller-text'],
};
const TOOL_CHAT: CapabilitySpec = {
  id: 'alpha.tool-chat',
  task: 'chat',
  ...base,
  audience: 'buyer',
  maxToolRounds: 2,
  dataCategories: ['customer-message'],
};
const SPECS = [WRITER, TOOL_CHAT];

const REQUEST: ModelRequest = {
  system: 'You write.',
  messages: [{ role: 'user', blocks: [{ type: 'text', text: 'Write for me, a@b.co' }] }],
  tools: [],
  maxOutputTokens: 5000,
};
const turnOf = (text: string): ModelTurn => ({
  blocks: [{ type: 'text', text }],
  stop: 'end',
  usage: { inputTokens: 100, outputTokens: 20 },
});
const EXTERNAL = turnOf('External answer');
const IN_HOUSE = turnOf('In-house answer with a halal claim');

const checkOf = (_request: ModelRequest, turn: ModelTurn): OutputCheck => {
  const text = turn.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('');
  return /halal/iu.test(text) ? 'guard-rejected' : 'valid';
};
const suiteOf = (capability: string): EvaluationSuite => ({
  capability,
  setVersion: 's-1',
  sampleIds: () => ['one'],
  label: () => 'one',
  request: () => ({ ...REQUEST, tools: [] }),
  grade: () => ({ passed: true, checks: [] }),
  display: () => null,
  shadow: checkOf,
});

class RouteProvider implements ModelProvider {
  readonly sent: { route: string; request: ModelRequest }[] = [];
  inHouse: () => Promise<ModelTurn> = () => Promise.resolve(IN_HOUSE);
  external: () => Promise<ModelTurn> = () => Promise.resolve(EXTERNAL);
  call(credentials: ModelCredentials, request: ModelRequest) {
    this.sent.push({ route: credentials.route, request });
    return credentials.route === 'in-house-http' ? this.inHouse() : this.external();
  }
}

const PERCENT: InHouseTaskPage = {
  stage: 'percent',
  family: 'model-house',
  shadowPercent: 0,
  rolloutPercent: 30,
};
const DEFAULT: InHouseTaskPage = { ...PERCENT, stage: 'default', rolloutPercent: 0 };

const adminContext = (market: MarketContext): CallContext =>
  testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'admin',
      accountId: '01938a2b-4123-7456-8abc-00000000000c' as Id<'Account'>,
      sessionId: '01938a2b-4123-7456-8abc-00000000000d' as Id<'Session'>,
      sellerId: null,
    }),
  );

const buyerContext = (market: MarketContext): CallContext =>
  testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'customer',
      accountId: '01938a2b-4123-7456-8abc-00000000000e' as Id<'Account'>,
      sessionId: '01938a2b-4123-7456-8abc-00000000000f' as Id<'Session'>,
      sellerId: null,
    }),
  );

describe('the live stages are served (G6d2)', () => {
  it('serves every stage', () => {
    expect(SERVED_IN_HOUSE_STAGES).toEqual(['off', 'shadow', 'percent', 'default']);
  });

  it('keeps one turn on one model: the bucket is fixed per Market, capability and turn', () => {
    const bucket = turnBucket('AU', TOOL_CHAT.id, 'turn-1');
    expect(bucket).toBeGreaterThanOrEqual(0);
    expect(bucket).toBeLessThan(100);
    expect(turnBucket('AU', TOOL_CHAT.id, 'turn-1')).toBe(bucket);
    // Over many turns the buckets spread over the range.
    const buckets = new Set(Array.from({ length: 500 }, (_, i) => turnBucket('AU', 'x', `t${i}`)));
    expect(buckets.size).toBeGreaterThan(90);
  });

  it('plans the in-house routes first, leaving room for an external fallback', () => {
    const route = (id: string): PlannedRoute => ({
      row: { id } as RouteRow,
      price: { inputPicoUsd: 1, outputPicoUsd: 1 },
    });
    const ids = (plan: readonly PlannedRoute[]) => plan.map((planned) => planned.row.id);
    const house = [route('h1'), route('h2'), route('h3')];
    const external = [route('e1'), route('e2')];
    expect(ids(livePlan(house, external))).toEqual(['h1', 'h2', 'e1']);
    expect(ids(livePlan(house.slice(0, 1), external))).toEqual(['h1', 'e1', 'e2']);
    expect(ids(livePlan(house, []))).toEqual(['h1', 'h2', 'h3']);
    expect(livePlan(house, external)).toHaveLength(MAX_ATTEMPTS);
  });
});

describe.each(['AU', 'ZZ'])('in-house percent and default stages (G6d2) in %s', (code) => {
  const market = testMarketContext(code, 'default');

  let provider: RouteProvider;
  let store: InMemoryAiUsageStore;
  let sampled: number[];
  let healthAsked: string[];
  let clock: FixedClock;
  let controls: TestAiGatewayControls;
  let rollback: InHouseRollback;
  let notices: RecordingRollbackNotices;

  const gatewayOf = (
    setup: {
      readonly page?: InHouseTaskPage;
      readonly pageMarkets?: readonly string[];
      readonly sample?: boolean;
      readonly healthy?: boolean;
      readonly houseRow?: Partial<RouteRow>;
      readonly housePass?: boolean;
      readonly houseKey?: boolean;
      readonly external?: boolean;
    } = {},
  ) => {
    const registry = new CapabilityRegistry();
    registry.register('alpha', SPECS);
    registry.seal();
    const suites = new EvaluationSuiteRegistry(registry);
    suites.register('alpha', [suiteOf(WRITER.id)]);
    suites.seal();
    clock = new FixedClock(NOW);
    const memory = inMemoryAiUsage(MARKETS, clock);
    store = memory.store;
    const models = new ModelGateway(
      {
        aiKillSwitch: false,
        assistantModels: {
          apiKeys: { [code]: 'sk-test-canary-key-0001' },
          bedrockApiKeys: {},
          inHouseApiKeys:
            setup.houseKey === false ? {} : { [code]: 'in-house-test-canary-key-0123456789abcdef' },
          removedVariables: [],
        },
      } as unknown as AppConfig,
      provider,
    );
    const passes = new EvaluationResults(
      SPECS.flatMap((spec) => [
        {
          capability: spec.id,
          provider: 'anthropic',
          family: 'model-fast',
          promptVersion: spec.promptVersion,
          passedOn: '2026-11-25',
          reference: 'test fixture',
        },
        ...(setup.housePass === false
          ? []
          : [
              {
                capability: spec.id,
                provider: 'mondapac',
                family: 'model-house',
                promptVersion: spec.promptVersion,
                passedOn: '2026-11-26',
                reference: 'test fixture',
              },
            ]),
      ]),
    );
    const catalogue = testRouteCatalogue([testInHouseRoute('model-house', setup.houseRow)]);
    const router = testRouter(catalogue, passes, models, MARKETS, clock);
    controls = new TestAiGatewayControls();
    if (setup.external !== false) controls.routed('model-fast', ['AU', 'ZZ']);
    const page = setup.page ?? PERCENT;
    controls.inHouseStage('write', page, setup.pageMarkets ?? [code]);
    controls.inHouseStage('chat', page, setup.pageMarkets ?? [code]);
    const rollout = testRollout(router, {
      suites,
      health: {
        healthy: (asked: MarketId, row: RouteRow) => {
          healthAsked.push(`${asked}|${row.id}`);
          return setup.healthy ?? true;
        },
      },
      sampler: {
        take: (percent) => {
          sampled.push(percent);
          return setup.sample ?? true;
        },
      },
    });
    return new AiGateway(
      models,
      registry,
      { isOn: () => Promise.resolve(true) },
      memory.usage,
      clock,
      router,
      controls,
      testShadow(router),
      rollout,
      (rollback = testRollback(router, {
        store,
        clock,
        capabilities: registry,
        notices: (notices = new RecordingRollbackNotices()),
      })),
    );
  };
  const routes = () => provider.sent.map((call) => call.route);

  beforeEach(() => {
    provider = new RouteProvider();
    sampled = [];
    healthAsked = [];
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('answers a call in the percent share from the in-house model, masked, counted for the caller', async () => {
    const run = await gatewayOf().run(WRITER.id, adminContext(market), REQUEST, {});
    expect(run).toMatchObject({
      ok: true,
      turn: IN_HOUSE,
      route: { provider: 'mondapac', route: 'in-house-http', attempt: 1 },
    });
    expect(routes()).toEqual(['in-house-http']);
    expect(JSON.stringify(provider.sent[0]!.request)).toContain(MASKED);
    expect(JSON.stringify(provider.sent[0]!.request)).not.toContain('a@b.co');
    expect(sampled).toEqual([30]);
    expect(healthAsked).toEqual([`${code}|in-house-http/model-house-v1`]);
    // A served call: not shadow, no sample, the capability's own check kept (G6d3).
    expect(store.calls).toEqual([
      expect.objectContaining({
        capability: WRITER.id,
        provider: 'mondapac',
        shadow: false,
        shadowSample: null,
        outputCheck: 'guard-rejected',
        outcome: 'ok',
        attempt: 1,
      }),
    ]);
  });

  it('keeps a call outside the share on the external models', async () => {
    const run = await gatewayOf({ sample: false }).run(
      WRITER.id,
      adminContext(market),
      REQUEST,
      {},
    );
    expect(run).toMatchObject({ ok: true, turn: EXTERNAL, route: { provider: 'anthropic' } });
    expect(routes()).toEqual(['anthropic-api']);
    expect(store.calls[0]).toEqual(expect.objectContaining({ outputCheck: null }));
  });

  it('answers every call in default, without a draw', async () => {
    const gateway = gatewayOf({ page: DEFAULT, sample: false });
    for (let i = 0; i < 3; i += 1) {
      const run = await gateway.run(WRITER.id, adminContext(market), REQUEST, {});
      expect(run).toMatchObject({ ok: true, turn: IN_HOUSE });
    }
    expect(sampled).toEqual([]);
    expect(routes()).toEqual(['in-house-http', 'in-house-http', 'in-house-http']);
  });

  it('falls back to the external models when the in-house call fails', async () => {
    provider.inHouse = () => Promise.reject(new Error('reset'));
    const run = await gatewayOf({ page: DEFAULT }).run(
      WRITER.id,
      adminContext(market),
      REQUEST,
      {},
    );
    expect(run).toMatchObject({
      ok: true,
      turn: EXTERNAL,
      route: { provider: 'anthropic', attempt: 2 },
    });
    expect(routes()).toEqual(['in-house-http', 'anthropic-api']);
    expect(store.calls).toEqual([
      expect.objectContaining({ provider: 'mondapac', outcome: 'unavailable', attempt: 1 }),
      expect.objectContaining({ provider: 'anthropic', outcome: 'ok', attempt: 2 }),
    ]);
  });

  it('sends nothing to an unhealthy in-house row: the call goes external', async () => {
    const run = await gatewayOf({ page: DEFAULT, healthy: false }).run(
      WRITER.id,
      adminContext(market),
      REQUEST,
      {},
    );
    expect(run).toMatchObject({ ok: true, turn: EXTERNAL });
    expect(routes()).toEqual(['anthropic-api']);
  });

  it.each([
    ['retired', { houseRow: { retiresOn: '2026-11-26' } }],
    ['not evaluated', { housePass: false }],
    ['without its key', { houseKey: false }],
    ['not checked by Hassan', { houseRow: { dataTerms: null } }],
    ['outside the region', { houseRow: { region: 'us-east-1' } }],
  ] as const)(
    'serves no in-house call from a stored live stage whose model is %s (call-time recheck)',
    async (_name, setup) => {
      const run = await gatewayOf({ page: DEFAULT, ...setup }).run(
        WRITER.id,
        adminContext(market),
        REQUEST,
        {},
      );
      expect(run).toMatchObject({ ok: true, turn: EXTERNAL });
      expect(routes()).toEqual(['anthropic-api']);
      expect(healthAsked).toEqual([]);
    },
  );

  it('reads the stage only as in force: a percent stage without its share is off', async () => {
    const run = await gatewayOf({ page: { ...PERCENT, rolloutPercent: 0 } }).run(
      WRITER.id,
      adminContext(market),
      REQUEST,
      {},
    );
    expect(run).toMatchObject({ ok: true, turn: EXTERNAL });
    expect(sampled).toEqual([]);
  });

  it('leaves the other Market on its external models (cross-Market canary)', async () => {
    const other = code === 'AU' ? 'ZZ' : 'AU';
    const gateway = gatewayOf({ page: DEFAULT, pageMarkets: [other] });
    const run = await gateway.run(WRITER.id, adminContext(market), REQUEST, {});
    expect(run).toMatchObject({ ok: true, turn: EXTERNAL });
    expect(routes()).toEqual(['anthropic-api']);
  });

  it('keeps a capability with tool rounds on one model for the whole turn in percent', async () => {
    const gateway = gatewayOf({ sample: false });
    // A turn id in the share and one outside it, for this Market and capability.
    const ids = Array.from({ length: 200 }, (_, i) => `turn-${i}`);
    const inside = ids.find((id) => turnBucket(code, TOOL_CHAT.id, id) < PERCENT.rolloutPercent)!;
    const outside = ids.find((id) => turnBucket(code, TOOL_CHAT.id, id) >= PERCENT.rolloutPercent)!;
    for (let round = 0; round < 2; round += 1) {
      await gateway.run(TOOL_CHAT.id, buyerContext(market), REQUEST, { turnId: inside });
    }
    for (let round = 0; round < 2; round += 1) {
      await gateway.run(TOOL_CHAT.id, buyerContext(market), REQUEST, { turnId: outside });
    }
    expect(routes()).toEqual(['in-house-http', 'in-house-http', 'anthropic-api', 'anthropic-api']);
    // The per-call draw is never asked for a capability with tool rounds.
    expect(sampled).toEqual([]);
  });

  it('keeps a task type without an external list off, even in default', async () => {
    const gateway = gatewayOf({ page: DEFAULT, external: false });
    expect(await gateway.status(WRITER.id, adminContext(market), {})).toEqual({
      on: false,
      reason: 'no-route',
    });
    expect(routes()).toEqual([]);
  });

  /** Served in-house rows of the writer, as earlier calls in the window left them. */
  const served = (count: number, row: Partial<CallRecord> = {}) => {
    for (let i = 0; i < count; i += 1) {
      store.calls.push({
        id: `0193${String(i).padStart(4, '0')}-0000-7000-8000-000000000000`,
        occurredAt: NOW.subtract({ minutes: 5 }),
        day: Temporal.PlainDate.from('2026-11-27'),
        capability: WRITER.id,
        sellerId: null,
        guest: false,
        provider: 'mondapac',
        model: 'model-house-v1',
        attempt: 1,
        inputTokens: 1,
        outputTokens: 1,
        inputPicoUsd: 1,
        outputPicoUsd: 1,
        costMicroUsd: 1,
        latencyMs: 1,
        outcome: 'ok',
        shadow: false,
        shadowSample: null,
        outputCheck: 'valid',
        ...row,
      });
    }
  };
  const runWriter = async (gateway: AiGateway) => {
    const run = await gateway.run(WRITER.id, adminContext(market), REQUEST, {});
    await rollback.settled();
    return run;
  };
  const LIMITS = { errorsPermille: 50, guardPermille: 50, minSample: 100 };

  describe('the auto-rollback (G6d3)', () => {
    it('rolls the live stage back when the error rate passes its limit, then serves external', async () => {
      const gateway = gatewayOf({ page: DEFAULT });
      controls.inHouseOf(code, { rollback: LIMITS });
      // 94 good and 5 failed calls in the window; this call makes 100 with 6 failed: 6 % > 5 %.
      served(94);
      served(5, { outcome: 'unavailable', outputCheck: null });
      provider.inHouse = () => Promise.reject(new Error('reset'));
      await runWriter(gateway);
      expect(store.rollbacks).toEqual([
        expect.objectContaining({
          marketId: code,
          task: 'write',
          family: 'model-house',
          stage: 'default',
          reason: 'errors',
          calls: 100,
          failures: 6,
          errorsLimitPermille: 50,
          minSample: 100,
          rolledBackAt: NOW,
        }),
      ]);
      // One notice for the admins (G6e2), codes only, under the Market's system actor.
      expect(notices.notices.map(({ notice }) => notice)).toEqual([
        {
          rollbackId: store.rollbacks[0]!.id,
          task: 'write',
          stage: 'default',
          reason: 'errors',
          rolledBackAt: NOW,
        },
      ]);
      const sent = notices.notices[0]!.context;
      expect([sent.market.marketId, sent.actor.kind, sent.actor.marketId]).toEqual([
        code,
        'system',
        code,
      ]);
      // From now on the task type's calls go to the external models only.
      provider.sent.length = 0;
      provider.inHouse = () => Promise.resolve(IN_HOUSE);
      const run = await runWriter(gateway);
      expect(run).toMatchObject({ ok: true, turn: EXTERNAL });
      expect(routes()).toEqual(['anthropic-api']);
    });

    it('rolls back on the guard-rejection rate of the answers', async () => {
      const gateway = gatewayOf({ page: DEFAULT });
      controls.inHouseOf(code, { rollback: { ...LIMITS, guardPermille: 10 } });
      served(98);
      served(1, { outputCheck: 'guard-rejected' });
      // This answer is guard-rejected too: 2 in 100 > 1 %.
      await runWriter(gateway);
      expect(store.rollbacks).toEqual([
        expect.objectContaining({ reason: 'guard', calls: 100, guardRejected: 2, failures: 0 }),
      ]);
    });

    it('judges nothing below the minimum sample, nor at the limit', async () => {
      const gateway = gatewayOf({ page: DEFAULT });
      controls.inHouseOf(code, { rollback: { ...LIMITS, minSample: 200 } });
      served(150, { outcome: 'timeout', outputCheck: null });
      await runWriter(gateway);
      expect(store.rollbacks).toEqual([]);
      expect(rollbackReason({ calls: 100, failures: 5, guardRejected: 5 }, LIMITS)).toBeNull();
      expect(rollbackReason({ calls: 100, failures: 6, guardRejected: 0 }, LIMITS)).toBe('errors');
      // A stored limit is taken in force: above the ceiling it is 5 %, below the floor sample 100.
      expect(
        rollbackReason(
          { calls: 100, failures: 6, guardRejected: 0 },
          { errorsPermille: 900, guardPermille: 50, minSample: 1 },
        ),
      ).toBe('errors');
    });

    it('counts only the window and the calls since the settings last changed', async () => {
      const gateway = gatewayOf({ page: DEFAULT });
      controls.inHouseOf(code, {
        rollback: LIMITS,
        changedAt: { write: NOW.subtract({ minutes: 10 }) },
      });
      // Failures before the change, or older than the window, are another stage's.
      served(100, { outcome: 'unavailable', occurredAt: NOW.subtract({ minutes: 20 }) });
      served(100, {
        outcome: 'unavailable',
        occurredAt: NOW.subtract(ROLLBACK_WINDOW).subtract({ minutes: 1 }),
      });
      served(99);
      await runWriter(gateway);
      expect(store.rollbacks).toEqual([]);
    });

    it('leaves shadow calls, other models and other task types out of the count', async () => {
      const gateway = gatewayOf({ page: DEFAULT });
      controls.inHouseOf(code, { rollback: LIMITS });
      served(99);
      served(50, { outcome: 'unavailable', shadow: true, shadowSample: 'x' });
      served(50, { outcome: 'unavailable', model: 'model-house-v0' });
      served(50, { outcome: 'unavailable', capability: TOOL_CHAT.id });
      await runWriter(gateway);
      expect(store.rollbacks).toEqual([]);
    });

    it('holds the stage off until an admin changes the task type after the rollback', async () => {
      const gateway = gatewayOf({ page: DEFAULT });
      await store.addInHouseRollback(market, {
        id: '0193aaaa-0000-7000-8000-000000000000',
        task: 'write',
        family: 'model-house',
        stage: 'default',
        reason: 'errors',
        calls: 100,
        failures: 10,
        guardRejected: 0,
        errorsLimitPermille: 50,
        guardLimitPermille: 50,
        minSample: 100,
        rolledBackAt: NOW.subtract({ minutes: 1 }),
      });
      // A change before the rollback does not lift it.
      controls.inHouseOf(code, { changedAt: { write: NOW.subtract({ minutes: 2 }) } });
      expect(await runWriter(gateway)).toMatchObject({ ok: true, turn: EXTERNAL });
      // A change after it does (read again after ROLLBACK_READ_FOR).
      controls.inHouseOf(code, { changedAt: { write: NOW } });
      clock.advance(ROLLBACK_READ_FOR);
      expect(await runWriter(gateway)).toMatchObject({ ok: true, turn: IN_HOUSE });
    });

    it("reads each task type's latest rollback and whether it holds the stage off, for the tab only of its Market (G6e2)", async () => {
      gatewayOf({ page: DEFAULT });
      const statusRead = new InHouseRollbackStatusRead(new InMemoryAiUsageUnitOfWork(store), store);
      const row = (minutes: number, reason: 'errors' | 'guard', id: string) => ({
        id,
        task: 'write',
        family: 'model-house',
        stage: 'percent' as const,
        reason,
        calls: 100,
        failures: reason === 'errors' ? 10 : 0,
        guardRejected: reason === 'guard' ? 10 : 0,
        errorsLimitPermille: 50,
        guardLimitPermille: 50,
        minSample: 100,
        rolledBackAt: NOW.subtract({ minutes }),
      });
      await store.addInHouseRollback(
        market,
        row(5, 'errors', '0193aaaa-0000-7000-8000-000000000001'),
      );
      await store.addInHouseRollback(
        market,
        row(1, 'guard', '0193aaaa-0000-7000-8000-000000000002'),
      );
      const latest: Partial<ReturnType<typeof row>> = row(1, 'guard', '');
      delete latest.id;
      expect(await statusRead.status(market, {})).toEqual([{ ...latest, heldOff: true }]);
      expect(await statusRead.status(market, { write: NOW.subtract({ minutes: 2 }) })).toEqual([
        { ...latest, heldOff: true },
      ]);
      expect(await statusRead.status(market, { write: NOW })).toEqual([
        { ...latest, heldOff: false },
      ]);
      const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
      expect(await statusRead.status(other, {})).toEqual([]);
      jest.spyOn(store, 'latestInHouseRollbacks').mockRejectedValue(new Error('down'));
      await expect(statusRead.status(market, {})).rejects.toThrow();
    });

    it('records no rollback when the notice cannot be written, and judges again later (G6e2)', async () => {
      const gateway = gatewayOf({ page: DEFAULT });
      controls.inHouseOf(code, { rollback: LIMITS });
      served(94);
      served(5, { outcome: 'unavailable', outputCheck: null });
      provider.inHouse = () => Promise.reject(new Error('reset'));
      const failing = jest
        .spyOn(notices, 'rolledBack')
        .mockRejectedValueOnce(new Error('outbox down'));
      await runWriter(gateway);
      // The row and the event are one unit: neither is kept.
      expect(store.rollbacks).toEqual([]);
      expect(notices.notices).toEqual([]);
      failing.mockRestore();
      clock.advance(ROLLBACK_JUDGE_EVERY);
      await runWriter(gateway);
      expect(store.rollbacks).toHaveLength(1);
      expect(notices.notices).toHaveLength(1);
    });

    it('holds every live stage off when the rollbacks cannot be read', async () => {
      const gateway = gatewayOf({ page: DEFAULT });
      jest.spyOn(store, 'latestInHouseRollbacks').mockRejectedValue(new Error('down'));
      const run = await runWriter(gateway);
      expect(run).toMatchObject({ ok: true, turn: EXTERNAL });
      expect(routes()).toEqual(['anthropic-api']);
    });

    it('judges at most every 30 s per task type, and never a call it did not route in-house', async () => {
      const gateway = gatewayOf({ page: DEFAULT });
      controls.inHouseOf(code, { rollback: LIMITS });
      const totals = jest.spyOn(store, 'servedTotals');
      await runWriter(gateway);
      await runWriter(gateway);
      expect(totals).toHaveBeenCalledTimes(1);
      clock.advance(ROLLBACK_JUDGE_EVERY);
      await runWriter(gateway);
      expect(totals).toHaveBeenCalledTimes(2);
      // Outside the share: no judge.
      const outside = gatewayOf({ sample: false });
      const outsideTotals = jest.spyOn(store, 'servedTotals');
      await runWriter(outside);
      expect(outsideTotals).not.toHaveBeenCalled();
    });

    it('rolls back only the Market it judged (cross-Market canary)', async () => {
      const gateway = gatewayOf({ page: DEFAULT, pageMarkets: ['AU', 'ZZ'] });
      controls.inHouseOf(code, { rollback: LIMITS });
      served(99, { outcome: 'unavailable', outputCheck: null });
      await runWriter(gateway);
      const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
      expect(store.rollbacks.map((row) => row.marketId)).toEqual([code]);
      expect(await rollback.heldOff(other, 'write', controls.inHouse.get(other.marketId)!)).toBe(
        false,
      );
    });
  });
});
