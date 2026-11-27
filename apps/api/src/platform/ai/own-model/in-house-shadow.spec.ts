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
  testRollback,
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
import { NO_IN_HOUSE, type AiInHouseControls } from '../gateway-controls';
import type { AiDataCategory, CapabilitySpec } from '../capability';
import { CapabilityRegistry } from '../capability-registry';
import { EvaluationResults } from '../evaluations/evaluation-results';
import {
  EvaluationSuiteRegistry,
  type EvaluationSuite,
  type OutputCheck,
} from '../evaluations/evaluation-suite';
import { ModelGateway } from '../model-gateway';
import type { ModelCredentials, ModelProvider, ModelRequest, ModelTurn } from '../model-provider';
import { MASKED } from '../personal-data-masker';
import { MAX_SHADOW_IN_FLIGHT, type InHouseShadow } from './in-house-shadow';
import type { InHouseTaskPage, ShadowApprovals } from './in-house-stage';

// Shadow runs of the in-house model through the real gateway (AI Gateway G6c; docs/design/domain/
// platform-ai.md sections 6 and 8): who is sent to shadow, what is kept of it, and that the caller
// only ever gets the external answer. Both Market fixtures (AU and ZZ).

const NOW = Temporal.Instant.from('2026-11-25T10:00:00Z');
const MARKETS = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const SELLER = '01938a2b-4123-7456-8abc-0123456789ab' as Id<'Seller'>;

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
/** Reads a certificate: a category the test approval does not cover. */
const READER: CapabilitySpec = {
  id: 'alpha.reader',
  task: 'write',
  ...base,
  dataCategories: ['seller-text', 'certificate-file'],
};
/** No evaluation suite with a shadow check. */
const UNCHECKED: CapabilitySpec = {
  id: 'alpha.unchecked',
  task: 'write',
  ...base,
  dataCategories: ['seller-text'],
};
/** Its own check throws. */
const BROKEN: CapabilitySpec = {
  id: 'alpha.broken',
  task: 'write',
  ...base,
  dataCategories: ['seller-text'],
};
const SELLER_WRITER: CapabilitySpec = {
  ...WRITER,
  id: 'alpha.seller-writer',
  audience: 'seller',
  sellerScoped: true,
};
const TOOL_CHAT: CapabilitySpec = {
  id: 'alpha.tool-chat',
  task: 'chat',
  ...base,
  audience: 'buyer',
  maxToolRounds: 2,
  dataCategories: ['customer-message'],
};
const SPECS = [WRITER, READER, UNCHECKED, BROKEN, SELLER_WRITER, TOOL_CHAT];

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

/** The capability's own check: a claim word is guard-rejected, text alone is valid. */
const checkOf = (_request: ModelRequest, turn: ModelTurn): OutputCheck => {
  const text = turn.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('');
  if (turn.stop !== 'end' || text.length === 0) return 'invalid';
  return /halal/iu.test(text) ? 'guard-rejected' : 'valid';
};
const suiteOf = (capability: string, withShadow = true): EvaluationSuite => ({
  capability,
  setVersion: 's-1',
  sampleIds: () => ['one'],
  label: () => 'one',
  request: () => ({ ...REQUEST, tools: [] }),
  grade: () => ({ passed: true, checks: [] }),
  display: () => null,
  ...(withShadow ? { shadow: checkOf } : {}),
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

const SHADOW_PAGE: InHouseTaskPage = {
  stage: 'shadow',
  family: 'model-house',
  shadowPercent: 25,
  rolloutPercent: 0,
};
const inHouseOf = (): AiInHouseControls => ({
  ...NO_IN_HOUSE,
  tasks: { write: SHADOW_PAGE },
});

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
const sellerContext = (market: MarketContext): CallContext =>
  testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'seller',
      accountId: '01938a2b-4123-7456-8abc-00000000000a' as Id<'Account'>,
      sessionId: '01938a2b-4123-7456-8abc-00000000000b' as Id<'Session'>,
      sellerId: SELLER,
    }),
  );

describe.each(['AU', 'ZZ'])('in-house shadow runs (G6c) in %s', (code) => {
  const marketId = code as MarketId;
  const market = testMarketContext(code, 'default');
  const approvalOf = (categories: readonly AiDataCategory[]): ShadowApprovals => ({
    [code]: { recordedIn: 'ADR-0052', approvedOn: '2026-11-27', categories },
  });

  let provider: RouteProvider;
  let store: InMemoryAiUsageStore;
  let shadow: InHouseShadow;
  let sampled: number[];
  let controls: TestAiGatewayControls;

  const gatewayOf = (
    setup: {
      readonly page?: InHouseTaskPage | null;
      readonly approvals?: ShadowApprovals;
      readonly sample?: boolean;
      readonly houseRow?: Parameters<typeof testInHouseRoute>[1];
      readonly housePass?: boolean;
      readonly houseKey?: boolean;
      readonly budget?: number;
    } = {},
  ) => {
    const registry = new CapabilityRegistry();
    registry.register('alpha', SPECS);
    registry.seal();
    const suites = new EvaluationSuiteRegistry(registry);
    suites.register('alpha', [
      suiteOf(WRITER.id),
      suiteOf(READER.id),
      suiteOf(UNCHECKED.id, false),
      suiteOf(SELLER_WRITER.id),
      {
        ...suiteOf(BROKEN.id),
        shadow: () => {
          throw new Error('broken check');
        },
      },
    ]);
    suites.seal();
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
    controls = (
      setup.budget === undefined
        ? new TestAiGatewayControls()
        : TestAiGatewayControls.everywhere({ marketDayMicroUsd: setup.budget })
    ).routed('model-fast', ['AU', 'ZZ']);
    const page = setup.page === undefined ? SHADOW_PAGE : setup.page;
    // Both Markets hold the stage (the cross-Market canary: only the approval tells them apart).
    if (page !== null) {
      controls.inHouseStage('write', page, ['AU', 'ZZ']);
      controls.inHouseStage('chat', page, ['AU', 'ZZ']);
    }
    shadow = testShadow(router, {
      suites,
      approvals: setup.approvals ?? approvalOf(['seller-text', 'customer-message']),
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
      shadow,
      testRollout(router),
      testRollback(router),
    );
  };

  const runWriter = async (gateway: AiGateway, capability = WRITER.id) => {
    const run = await gateway.run(capability, adminContext(market), REQUEST, {});
    await shadow.settled();
    return run;
  };
  const routes = () => provider.sent.map((call) => call.route);

  beforeEach(() => {
    provider = new RouteProvider();
    sampled = [];
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('sends a sampled call also to the in-house model; the caller gets the external answer', async () => {
    const run = await runWriter(gatewayOf());
    expect(run).toMatchObject({
      ok: true,
      turn: EXTERNAL,
      route: { provider: 'anthropic', model: 'model-fast', attempt: 1 },
    });
    // The external call first, then the shadow call with the same masked request.
    expect(routes()).toEqual(['anthropic-api', 'in-house-http']);
    expect(provider.sent[1]!.request).toEqual(provider.sent[0]!.request);
    expect(JSON.stringify(provider.sent[1]!.request)).toContain(MASKED);
    expect(JSON.stringify(provider.sent[1]!.request)).not.toContain('a@b.co');
    // The stage's share was asked of the sampler.
    expect(sampled).toEqual([25]);
  });

  it('keeps a row per call, numbers and the check only, and counts shadow on the same budget', async () => {
    await runWriter(gatewayOf());
    expect(store.calls).toEqual([
      expect.objectContaining({
        capability: WRITER.id,
        provider: 'anthropic',
        shadow: false,
        outputCheck: 'valid',
        outcome: 'ok',
      }),
      expect.objectContaining({
        capability: WRITER.id,
        provider: 'mondapac',
        model: 'model-house-v1',
        shadow: true,
        outputCheck: 'guard-rejected',
        outcome: 'ok',
        inputTokens: 100,
        outputTokens: 20,
      }),
    ]);
    // No answer text is kept anywhere.
    expect(JSON.stringify(store.calls)).not.toMatch(/answer|halal|Write for me/u);
    const [external, house] = store.calls;
    // The day rows count one request of the capability; the shadow call adds only its cost.
    expect(store.usage).toEqual([
      expect.objectContaining({ calls: 1, costMicroUsd: external!.costMicroUsd }),
      expect.objectContaining({
        calls: 0,
        failures: 0,
        fallbacks: 0,
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: null,
        costMicroUsd: house!.costMicroUsd,
      }),
    ]);
    const marketDay = store.counterOf(market, {
      period: 'day',
      periodStart: Temporal.PlainDate.from('2026-11-25'),
      scope: 'market',
      scopeKey: '',
    });
    expect(marketDay).toEqual({
      held: external!.costMicroUsd + house!.costMicroUsd,
      spent: external!.costMicroUsd + house!.costMicroUsd,
    });
  });

  it('checks no answer and sends no shadow when the call is not sampled', async () => {
    await runWriter(gatewayOf({ sample: false }));
    expect(routes()).toEqual(['anthropic-api']);
    expect(store.calls).toEqual([expect.objectContaining({ shadow: false, outputCheck: null })]);
  });

  it.each<[string, Parameters<typeof gatewayOf>[0]]>([
    ['the stage is off', { page: { ...SHADOW_PAGE, stage: 'off' } }],
    ['no stage is stored', { page: null }],
    ['the stored stage is not served (percent)', { page: { ...SHADOW_PAGE, stage: 'percent' } }],
    ['the stored share is 0', { page: { ...SHADOW_PAGE, shadowPercent: 0 } }],
    ['the stored model is gone', { page: { ...SHADOW_PAGE, family: null } }],
    ['the Market has no owner approval', { approvals: {} }],
    ['the approval is for another category', { approvals: approvalOf(['customer-message']) }],
    // FE-279: the route is checked again on each call, whatever the stored stage says.
    ['the version has no evaluation pass', { housePass: false }],
    ['the version is retired', { houseRow: { retiresOn: '2026-11-24' } }],
    ["Hassan's check is not recorded", { houseRow: { dataTerms: null } }],
    ['the Market holds no in-house key', { houseKey: false }],
    ['the row is outside the Market region', { houseRow: { region: 'us-east-1' } }],
  ])('sends nothing to the in-house model when %s', async (_name, setup) => {
    const run = await runWriter(gatewayOf(setup));
    expect(run).toMatchObject({ ok: true, turn: EXTERNAL });
    expect(routes()).toEqual(['anthropic-api']);
    expect(store.calls.every((call) => !call.shadow && call.outputCheck === null)).toBe(true);
  });

  it('never sends a capability with a category the owner did not approve', async () => {
    await runWriter(gatewayOf(), READER.id);
    expect(routes()).toEqual(['anthropic-api']);
    expect(sampled).toEqual([]);
  });

  it('never sends a capability without its own check of an answer', async () => {
    await runWriter(gatewayOf(), UNCHECKED.id);
    expect(routes()).toEqual(['anthropic-api']);
  });

  it('never sends a capability with tool rounds', async () => {
    const gateway = gatewayOf();
    const buyer = testCallContext(market, 'anonymous');
    await gateway.run(TOOL_CHAT.id, buyer, REQUEST, { turnId: 'turn-1' });
    await shadow.settled();
    expect(routes()).toEqual(['anthropic-api']);
    expect(sampled).toEqual([]);
  });

  it("counts a seller capability's shadow call on the Market and capability, never the seller", async () => {
    const gateway = gatewayOf();
    await gateway.run(SELLER_WRITER.id, sellerContext(market), REQUEST, { sellerId: SELLER });
    await shadow.settled();
    expect(routes()).toEqual(['anthropic-api', 'in-house-http']);
    expect(store.calls.map((call) => [call.sellerId, call.shadow])).toEqual([
      [SELLER, false],
      [null, true],
    ]);
    const sellerDay = store.counterOf(market, {
      period: 'day',
      periodStart: Temporal.PlainDate.from('2026-11-25'),
      scope: 'seller',
      scopeKey: SELLER,
    });
    expect(sellerDay?.spent).toBe(store.calls[0]!.costMicroUsd);
  });

  it('sends no shadow when the external call was refused over budget', async () => {
    const run = await runWriter(gatewayOf({ budget: 0 }));
    expect(run).toMatchObject({ ok: false, reason: 'over-budget' });
    expect(routes()).toEqual([]);
  });

  it('keeps a failing shadow call from the caller: its row records the failure, no check', async () => {
    const gateway = gatewayOf();
    provider.inHouse = () => Promise.reject(new Error('partner endpoint down'));
    const run = await runWriter(gateway);
    expect(run).toMatchObject({ ok: true, turn: EXTERNAL });
    expect(routes()).toEqual(['anthropic-api', 'in-house-http']);
    expect(store.calls[1]).toMatchObject({ shadow: true, outputCheck: null });
    expect(store.calls[1]!.outcome).not.toBe('ok');
  });

  it('answers the caller before the shadow call ends', async () => {
    const gateway = gatewayOf();
    let release: (turn: ModelTurn) => void = () => undefined;
    provider.inHouse = () =>
      new Promise<ModelTurn>((resolve) => {
        release = resolve;
      });
    const run = await gateway.run(WRITER.id, adminContext(market), REQUEST, {});
    expect(run).toMatchObject({ ok: true, turn: EXTERNAL });
    // The shadow call is still out; only the external row is settled.
    expect(store.calls).toHaveLength(1);
    release(IN_HOUSE);
    await shadow.settled();
    expect(store.calls).toHaveLength(2);
  });

  it('takes the in-flight slot at sampling, so a burst cannot pass the cap (Hassan 1)', async () => {
    const gateway = gatewayOf();
    // A burst: every sample is taken before any external call comes back.
    const burst = Array.from({ length: MAX_SHADOW_IN_FLIGHT + 3 }, () =>
      shadow.sample(marketId, WRITER, REQUEST, inHouseOf()),
    );
    expect(burst.filter((sample) => sample !== null)).toHaveLength(MAX_SHADOW_IN_FLIGHT);
    await gateway.run(WRITER.id, adminContext(market), REQUEST, {});
    await shadow.settled();
    expect(routes()).toEqual(['anthropic-api']);
    expect(store.calls).toEqual([expect.objectContaining({ shadow: false, outputCheck: null })]);
    // A sample whose external call was not sent gives its slot back.
    for (const sample of burst) if (sample !== null) shadow.drop();
    expect(shadow.sample(marketId, WRITER, REQUEST, inHouseOf())).not.toBeNull();
  });

  it('gives the slot back when the external call is refused', async () => {
    const gateway = gatewayOf({ budget: 0 });
    for (let call = 0; call < MAX_SHADOW_IN_FLIGHT + 1; call += 1) {
      await gateway.run(WRITER.id, adminContext(market), REQUEST, {});
    }
    expect(sampled).toHaveLength(MAX_SHADOW_IN_FLIGHT + 1);
  });

  it('puts the same sample id on both calls of a sample, and none outside one', async () => {
    const gateway = gatewayOf();
    await runWriter(gateway);
    const [external, house] = store.calls;
    expect(external!.shadowSample).toMatch(/^[0-9a-f-]{36}$/u);
    expect(house!.shadowSample).toBe(external!.shadowSample);
    await runWriter(gatewayOf({ sample: false }));
    expect(store.calls.map((call) => call.shadowSample)).toEqual([null]);
  });

  it('sends no shadow call when a stop is set while the external call is out (Hassan 2)', async () => {
    const gateway = gatewayOf();
    provider.external = () => {
      controls.stopped.add(code);
      return Promise.resolve(EXTERNAL);
    };
    const run = await runWriter(gateway);
    expect(run).toMatchObject({ ok: true, turn: EXTERNAL });
    expect(routes()).toEqual(['anthropic-api']);
  });

  it('sends no shadow call when the stage is switched off while the external call is out', async () => {
    const gateway = gatewayOf();
    provider.external = () => {
      controls.inHouseStage('write', { ...SHADOW_PAGE, stage: 'off' }, [code]);
      return Promise.resolve(EXTERNAL);
    };
    await runWriter(gateway);
    expect(routes()).toEqual(['anthropic-api']);
  });

  it('counts no refusal on the day row when the shadow call is over budget', async () => {
    // Room for the external call only: the dear in-house row's reservation does not fit.
    const gateway = gatewayOf({
      budget: 10_000,
      houseRow: { inputUsdPerMTok: 100, outputUsdPerMTok: 500 },
    });
    const run = await runWriter(gateway);
    expect(run).toMatchObject({ ok: true });
    expect(routes()).toEqual(['anthropic-api']);
    expect(store.usage.every((row) => row.refusals === 0)).toBe(true);
  });

  it('stops sampling on close and settles the shadow calls still out first', async () => {
    const gateway = gatewayOf();
    let release: (turn: ModelTurn) => void = () => undefined;
    provider.inHouse = () =>
      new Promise<ModelTurn>((resolve) => {
        release = resolve;
      });
    await gateway.run(WRITER.id, adminContext(market), REQUEST, {});
    // The shadow call reaches the in-house model, then the application closes.
    for (let tick = 0; tick < 50 && routes().length < 2; tick += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(routes()).toEqual(['anthropic-api', 'in-house-http']);
    const closing = shadow.beforeApplicationShutdown();
    expect(shadow.sample(marketId, WRITER, REQUEST, inHouseOf())).toBeNull();
    release(IN_HOUSE);
    await closing;
    expect(store.calls.filter((call) => call.shadow)).toHaveLength(1);
  });

  it('records no check when the capability check throws, and the call still stands', async () => {
    const run = await runWriter(gatewayOf(), BROKEN.id);
    expect(run).toMatchObject({ ok: true, turn: EXTERNAL });
    expect(routes()).toEqual(['anthropic-api', 'in-house-http']);
    expect(store.calls).toEqual([
      expect.objectContaining({ shadow: false, outcome: 'ok', outputCheck: null }),
      expect.objectContaining({ shadow: true, outcome: 'ok', outputCheck: null }),
    ]);
  });

  it('is never sampled for a Market other than the approved one', async () => {
    const other = code === 'AU' ? 'ZZ' : 'AU';
    const gateway = gatewayOf({
      approvals: {
        [other]: {
          recordedIn: 'ADR-0052',
          approvedOn: '2026-11-27',
          categories: ['seller-text'],
        },
      },
    });
    await runWriter(gateway);
    expect(routes()).toEqual(['anthropic-api']);
    expect(marketId).toBe(code);
  });
});
