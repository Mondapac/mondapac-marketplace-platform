import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
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
} from '../../../../test/support/in-memory-ai-usage';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { passesFor, testRouteCatalogue, testRouter } from '../../../../test/support/ai-routes';
import type { AppConfig } from '../../../platform/config/app-config';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { AiGateway } from '../../../platform/ai/ai-gateway';
import { CapabilityRegistry } from '../../../platform/ai/capability-registry';
import { ModelGateway } from '../../../platform/ai/model-gateway';
import type { ModelProvider, ModelRequest, ModelTurn } from '../../../platform/ai/model-provider';
import { MASKED } from '../../../platform/ai/personal-data-masker';
import { CATALOG_AI_CAPABILITIES } from '../contracts/ai-capabilities';
import { guardDraft } from '../domain/description-writer/draft-guard';
import { TestAiGatewayControls } from '../../../../test/support/ai-gateway-controls';
import { GatewayDescriptionWriterModel } from './gateway-description-writer-model';

const AU = testMarketContext('AU', 'default');
const ZZ = testMarketContext('ZZ', 'default');
const SELLER = '01938a2b-4123-7456-8abc-0123456789ab' as Id<'Seller'>;
const TURN: ModelTurn = {
  blocks: [{ type: 'text', text: 'A sturdy pan.' }],
  stop: 'end',
  usage: { inputTokens: 10, outputTokens: 5 },
};
const REQUEST = { system: 'You write.', input: 'Pan, call 0412 345 678', maxOutputTokens: 5000 };
const configOf = () =>
  ({
    aiKillSwitch: false,
    assistantModels: {
      apiKeys: { AU: 'sk-test-canary-key-0001', ZZ: 'sk-test-canary-key-0002' },
      bedrockApiKeys: {},
      inHouseApiKeys: {},
      removedVariables: [],
    },
  }) as unknown as AppConfig;

function sellerContext(market = AU): CallContext {
  return testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'seller',
      accountId: '01938a2b-4123-7456-8abc-00000000000a' as Id<'Account'>,
      sessionId: '01938a2b-4123-7456-8abc-00000000000b' as Id<'Session'>,
      sellerId: SELLER,
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

describe('GatewayDescriptionWriterModel on the real AiGateway (AIS-03; ADR-0019 R8)', () => {
  let requests: ModelRequest[];
  let sellerOn: boolean;

  let store: InMemoryAiUsageStore;
  let controls: TestAiGatewayControls;
  const modelOf = () => {
    const registry = new CapabilityRegistry();
    registry.register('catalog', CATALOG_AI_CAPABILITIES);
    registry.seal();
    const provider: ModelProvider = {
      call: (_credentials, request) => {
        requests.push(request);
        return Promise.resolve(TURN);
      },
    };
    const clock = new FixedClock(Temporal.Instant.from('2026-11-25T10:00:00Z'));
    const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
    const { usage, store: usageStore } = inMemoryAiUsage(markets, clock);
    store = usageStore;
    const models = new ModelGateway(configOf(), provider);
    // Both Markets choose `model-fast` for every task type (the AI Models page, G4b).
    controls = new TestAiGatewayControls().routed('model-fast', ['AU', 'ZZ']);
    const gateway = new AiGateway(
      models,
      registry,
      { isOn: () => Promise.resolve(sellerOn) },
      usage,
      clock,
      testRouter(testRouteCatalogue(), passesFor(CATALOG_AI_CAPABILITIES), models, markets, clock),
      controls,
    );
    return new GatewayDescriptionWriterModel(gateway);
  };

  beforeEach(() => {
    requests = [];
    sellerOn = true;
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['AU', AU],
    ['ZZ', ZZ],
  ])('writes for a seller with the switch on, masked and capped (%s)', async (_name, market) => {
    const model = modelOf();
    const audience = { kind: 'seller', sellerId: SELLER } as const;
    expect(await model.available(sellerContext(market), audience)).toBe(true);
    expect(await model.write(sellerContext(market), audience, REQUEST, 60_000)).toEqual({
      ok: true,
      text: 'A sturdy pan.',
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.maxOutputTokens).toBe(700);
    expect(requests[0]!.messages[0]!.blocks[0]).toEqual({
      type: 'text',
      text: `Pan, call ${MASKED}`,
    });
  });

  it("is not available and calls nothing when the seller's switch is off", async () => {
    sellerOn = false;
    const model = modelOf();
    const audience = { kind: 'seller', sellerId: SELLER } as const;
    expect(await model.available(sellerContext(), audience)).toBe(false);
    expect(await model.write(sellerContext(), audience, REQUEST, 1000)).toEqual({
      ok: false,
      failure: 'not-configured',
    });
    expect(requests).toHaveLength(0);
  });

  it("is not available and calls nothing when the seller's AI budget for the day is used up (ZZ caps it; R8)", async () => {
    const model = modelOf();
    const audience = { kind: 'seller', sellerId: SELLER } as const;
    // The ZZ fixture caps each seller's day at 50,000,000 micro-dollars.
    store.counters.set(`ZZ|day|2026-11-25|seller|${SELLER}`, {
      held: 50_000_000,
      spent: 50_000_000,
    });
    expect(await model.available(sellerContext(ZZ), audience)).toBe(false);
    expect(await model.write(sellerContext(ZZ), audience, REQUEST, 1000)).toEqual({
      ok: false,
      failure: 'unavailable',
    });
    expect(requests).toHaveLength(0);
    // AU sets no cap: the same spend is counted, never refused.
    store.counters.set(`AU|day|2026-11-25|seller|${SELLER}`, {
      held: 50_000_000,
      spent: 50_000_000,
    });
    expect(await model.available(sellerContext(AU), audience)).toBe(true);
  });

  it('keeps the audiences apart: a seller cannot use the admin writer, nor an admin the seller one', async () => {
    const model = modelOf();
    expect(await model.available(sellerContext(), { kind: 'admin' })).toBe(false);
    expect(await model.available(adminContext(), { kind: 'seller', sellerId: SELLER })).toBe(false);
    expect(await model.available(adminContext(), { kind: 'admin' })).toBe(true);
  });

  it.each([
    ['AU', AU],
    ['ZZ', ZZ],
  ])(
    'is off and calls nothing when the Market has no list for the write task type (%s; G4d1, R8)',
    async (code, market) => {
      const model = modelOf();
      // No list for `write` (only `chat` has one): no fallback model, so the writer is off and the
      // product form completes without it (the panel hides "Write with AI").
      controls.models.set(code, {
        lists: { chat: ['model-fast'] },
        savers: {},
        saverAtPercent: 80,
      });
      const seller = { kind: 'seller', sellerId: SELLER } as const;
      expect(await model.available(sellerContext(market), seller)).toBe(false);
      expect(await model.available(adminContext(market), { kind: 'admin' })).toBe(false);
      expect(await model.write(sellerContext(market), seller, REQUEST, 1000)).toEqual({
        ok: false,
        failure: 'not-configured',
      });
      expect(requests).toHaveLength(0);
      expect(store.counters.size).toBe(0);
    },
  );

  it("drops a draft sentence that echoes the gateway's mask", () => {
    const draft = guardDraft(`A sturdy pan. Call ${MASKED} to ask.`, 'pan');
    expect(draft.sentences.map((s) => s.text)).toEqual(['A sturdy pan.']);
    expect(draft.leftOut).toEqual({ certification: 0, other: 1 });
    expect(guardDraft('A masked ball costume.', 'costume').sentences).toHaveLength(1);
  });
});
