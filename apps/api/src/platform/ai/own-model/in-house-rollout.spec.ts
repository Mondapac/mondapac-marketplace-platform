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
  testRouteCatalogue,
  testRouter,
  testRollout,
  testShadow,
} from '../../../../test/support/ai-routes';
import {
  inMemoryAiUsage,
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
    const clock = new FixedClock(NOW);
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
    const controls = new TestAiGatewayControls();
    if (setup.external !== false) controls.routed('model-fast', ['AU', 'ZZ']);
    const page = setup.page ?? PERCENT;
    controls.inHouseStage('write', page, setup.pageMarkets ?? [code]);
    controls.inHouseStage('chat', page, setup.pageMarkets ?? [code]);
    const rollout = testRollout(router, {
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
    // A served call: not shadow, no sample (its check joins with the auto-rollback, G6d3).
    expect(store.calls).toEqual([
      expect.objectContaining({
        capability: WRITER.id,
        provider: 'mondapac',
        shadow: false,
        shadowSample: null,
        outputCheck: null,
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
});
