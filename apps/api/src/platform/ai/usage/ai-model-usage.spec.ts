import { Temporal } from '@mondapac/shared-kernel';
import { FixedClock, testMarketContext } from '@mondapac/shared-kernel/testing';
import {
  passesFor,
  testRoute,
  testRouteCatalogue,
  testRouter,
} from '../../../../test/support/ai-routes';
import {
  InMemoryAiUsageStore,
  InMemoryAiUsageUnitOfWork,
} from '../../../../test/support/in-memory-ai-usage';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AppConfig } from '../../config/app-config';
import { loadMarketConfigs } from '../../market-config/market-config';
import { MarketRegistry } from '../../market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../../market-context/tenant';
import type { CapabilitySpec } from '../capability';
import { CapabilityRegistry } from '../capability-registry';
import { ModelGateway } from '../model-gateway';
import type { ModelProvider } from '../model-provider';
import { AiModelUsage, p95Of, tokensCostMicroUsd } from './ai-model-usage';
import { AI_EVALUATION_USAGE } from './ai-usage';
import type { CallRecord } from './ai-usage-store';

// The AI Models page's usage read (AI Gateway G5e; docs/design/domain/platform-ai.md section 8,
// Scorecard and Change preview): per family from the calls of the last 30 Market days, evaluation
// calls left out; per task type the day rows' tokens priced on each family. Both Market fixtures.

const NOW = Temporal.Instant.from('2026-11-26T02:00:00Z');
const MARKETS = new MarketRegistry(
  new Map(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS)),
);
const base = {
  audience: 'admin',
  sellerScoped: false,
  maxInputTokens: 4000,
  maxOutputTokens: 500,
  maxToolRounds: 0,
  timeoutMs: 1000,
  promptVersion: 'p-1',
} as const;
const WRITER: CapabilitySpec = { id: 'alpha.writer', task: 'write', ...base };
const CHAT: CapabilitySpec = { id: 'alpha.chat', task: 'chat', ...base };

const NO_PROVIDER: ModelProvider = {
  call: () => Promise.reject(new Error('no model is called by a usage read')),
};
const CONFIG = {
  aiKillSwitch: false,
  assistantModels: {
    apiKeys: { AU: 'sk-test-canary-key-0001', ZZ: 'sk-test-canary-key-0001' },
    bedrockApiKeys: {},
    removedVariables: [],
  },
} as unknown as AppConfig;

function setUp() {
  const registry = new CapabilityRegistry();
  registry.register('alpha', [WRITER, CHAT]);
  registry.seal();
  const store = new InMemoryAiUsageStore();
  const router = testRouter(
    testRouteCatalogue([testRoute('model-unchecked', 'anthropic-api', { dataTerms: null })]),
    // model-balanced passed both capabilities; model-fast none.
    passesFor([WRITER, CHAT], ['model-balanced']),
    new ModelGateway(CONFIG, NO_PROVIDER),
    MARKETS,
    new FixedClock(NOW),
  );
  const usage = new AiModelUsage(
    store,
    new InMemoryAiUsageUnitOfWork(store),
    new FixedClock(NOW),
    MARKETS,
    router,
    registry,
  );
  return { store, usage };
}

let n = 0;
function call(overrides: Partial<CallRecord>): CallRecord {
  n += 1;
  return {
    id: `01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`,
    occurredAt: NOW.subtract({ hours: 1 }),
    day: Temporal.PlainDate.from('2026-11-26'),
    capability: WRITER.id,
    sellerId: null,
    guest: false,
    provider: 'anthropic',
    model: 'model-fast',
    attempt: 1,
    inputTokens: 100,
    outputTokens: 50,
    inputPicoUsd: 1_000_000,
    outputPicoUsd: 5_000_000,
    costMicroUsd: 400,
    latencyMs: 300,
    outcome: 'ok',
    ...overrides,
  };
}

describe('p95Of', () => {
  it('is the first bucket that holds 95 % of the calls (nearest rank)', () => {
    expect(p95Of(0, [0, 0, 0, 0, 0, 0, 0])).toBeNull();
    expect(p95Of(20, [19, 19, 20, 20, 20, 20, 20])).toEqual({ bound: 500, above: false });
    expect(p95Of(20, [18, 18, 19, 20, 20, 20, 20])).toEqual({ bound: 2000, above: false });
    expect(p95Of(1, [0, 0, 0, 0, 0, 0, 0])).toEqual({ bound: 32_000, above: true });
  });
});

describe('tokensCostMicroUsd', () => {
  it('rounds up and stays exact past 2^53 pico dollars', () => {
    expect(tokensCostMicroUsd(1, 0, { inputPicoUsd: 1, outputPicoUsd: 1 })).toBe(1);
    expect(
      tokensCostMicroUsd(3_000_000_000, 1_000_000_000, {
        inputPicoUsd: 15_000_000,
        outputPicoUsd: 75_000_000,
      }),
    ).toBe(120_000_000_000);
  });
});

describe.each(['AU', 'ZZ'])('AiModelUsage (G5e), Market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);

  it('sums each family over its routes, leaves out evaluation calls and old calls', async () => {
    const { store, usage } = setUp();
    store.calls.push(
      call({ latencyMs: 400 }),
      call({ model: 'anthropic.model-fast', latencyMs: 1500, outcome: 'timeout', attempt: 2 }),
      call({ latencyMs: 900, costMicroUsd: 600 }),
      // Not counted: an evaluation call, a call older than the window, a model no row names.
      call({ capability: AI_EVALUATION_USAGE, costMicroUsd: 99_999 }),
      call({ occurredAt: NOW.subtract({ hours: 31 * 24 }), costMicroUsd: 99_999 }),
      call({ model: 'model-gone', costMicroUsd: 99_999 }),
    );
    const view = await usage.read(market);

    expect(view.days).toBe(30);
    expect(view.to).toBe(
      NOW.toZonedDateTimeISO(MARKETS.get(market.marketId).timezone).toPlainDate().toString(),
    );
    expect(view.families.map((item) => item.family)).toEqual([
      'model-balanced',
      'model-fast',
      'model-unchecked',
    ]);
    const fast = view.families.find((item) => item.family === 'model-fast')!;
    expect(fast).toEqual({
      family: 'model-fast',
      provider: 'anthropic',
      calls: 3,
      failures: 1,
      stoodIn: 1,
      costMicroUsd: 1400,
      p95: { bound: 2000, above: false },
      evaluation: { passed: 0, of: 2 },
    });
    const balanced = view.families.find((item) => item.family === 'model-balanced')!;
    expect(balanced).toMatchObject({ calls: 0, failures: 0, p95: null });
    expect(balanced.evaluation).toEqual({ passed: 2, of: 2 });
  });

  it('prices each task type’s tokens on every family, null where no route is usable', async () => {
    const { store, usage } = setUp();
    const today = NOW.toZonedDateTimeISO(MARKETS.get(market.marketId).timezone).toPlainDate();
    const row = {
      day: today,
      sellerId: null,
      calls: 10,
      failures: 0,
      refusals: 0,
      fallbacks: 0,
      costMicroUsd: 0,
      latencyMs: 100,
    };
    store.usage.push(
      { ...row, capability: WRITER.id, inputTokens: 1_000_000, outputTokens: 100_000 },
      {
        ...row,
        capability: WRITER.id,
        day: today.subtract({ days: 29 }),
        inputTokens: 1_000_000,
        outputTokens: 100_000,
      },
      // Outside the window, an evaluation row, and a capability no longer registered.
      {
        ...row,
        capability: WRITER.id,
        day: today.subtract({ days: 30 }),
        inputTokens: 9e9,
        outputTokens: 0,
      },
      { ...row, capability: AI_EVALUATION_USAGE, inputTokens: 9e9, outputTokens: 0 },
      { ...row, capability: 'alpha.gone', inputTokens: 9e9, outputTokens: 0 },
    );
    const view = await usage.read(market);
    const write = view.tasks.find((item) => item.task === 'write')!;
    expect(write).toMatchObject({ calls: 20, inputTokens: 2_000_000, outputTokens: 200_000 });
    // model-fast 1 / 5 USD per MTok: 2 + 1 = 3 USD; model-balanced 3 / 15: 6 + 3 = 9 USD.
    expect(write.costByFamily).toEqual([
      { family: 'model-balanced', costMicroUsd: 9_000_000 },
      { family: 'model-fast', costMicroUsd: 3_000_000 },
      { family: 'model-unchecked', costMicroUsd: null },
    ]);
    const vision = view.tasks.find((item) => item.task === 'vision')!;
    expect(vision.costByFamily.every((item) => item.costMicroUsd === null)).toBe(true);
  });

  it('throws when the store cannot be read (the route answers 500, nothing is guessed)', async () => {
    const { store, usage } = setUp();
    store.failing = true;
    await expect(usage.read(market)).rejects.toThrow();
  });
});
