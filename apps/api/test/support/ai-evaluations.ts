import { AsyncLocalStorage } from 'node:async_hooks';
import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import type { AppConfig } from '../../src/platform/config/app-config';
import type { CapabilitySpec } from '../../src/platform/ai/capability';
import { CapabilityRegistry } from '../../src/platform/ai/capability-registry';
import type { RouteRow } from '../../src/platform/ai/catalogue/route-catalogue';
import { AiEvaluationControl } from '../../src/platform/ai/evaluations/evaluation-control';
import { AiEvaluationGateway } from '../../src/platform/ai/evaluations/evaluation-gateway';
import { EvaluationResults } from '../../src/platform/ai/evaluations/evaluation-results';
import { AiEvaluationRunner } from '../../src/platform/ai/evaluations/evaluation-runner';
import {
  EvaluationSuiteRegistry,
  type EvaluationGrade,
  type EvaluationSuite,
} from '../../src/platform/ai/evaluations/evaluation-suite';
import { ModelGateway } from '../../src/platform/ai/model-gateway';
import { AiUsage } from '../../src/platform/ai/usage/ai-usage';
import type { ModelProvider, ModelRequest, ModelTurn } from '../../src/platform/ai/model-provider';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { TestAiGatewayControls, type TestBudget } from './ai-gateway-controls';
import { testRouteCatalogue, testRouter } from './ai-routes';
import { inMemoryAiUsage } from './in-memory-ai-usage';
import { InMemoryAiEvaluationStore } from './in-memory-ai-evaluations';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from './test-config';
import { NestedUnitOfWorkError } from '../../src/platform/unit-of-work/errors';
import type { UnitOfWork, UnitOfWorkOptions } from '../../src/platform/unit-of-work/unit-of-work';

export const EVAL_NOW = Temporal.Instant.from('2026-11-25T10:00:00Z');
export const ADMIN_ID = '01938a2b-4123-7456-8abc-00000000000c';

const base = {
  task: 'write',
  maxInputTokens: 4000,
  maxOutputTokens: 500,
  maxToolRounds: 0,
  timeoutMs: 1000,
  promptVersion: 'p-1',
} as const;

/** Two writers without tools (evaluated in G4c1) and a chat with tool rounds (G4c2). */
export const EVAL_SPECS: CapabilitySpec[] = [
  { id: 'alpha.seller-writer', audience: 'seller', sellerScoped: true, ...base },
  { id: 'alpha.admin-writer', audience: 'admin', sellerScoped: false, ...base },
  {
    id: 'alpha.tool-chat',
    audience: 'buyer',
    sellerScoped: false,
    ...base,
    task: 'chat',
    maxToolRounds: 2,
  },
];

/** A synthetic sample: the only text it sends, the fact it must keep and what it must never show. */
export interface FakeSample {
  readonly id: string;
  readonly text: string;
  readonly mustShow: string;
  readonly mustNotShow: string;
}

export const FAKE_SAMPLES: readonly FakeSample[] = [
  {
    id: 's-1',
    text: 'Synthetic rice 1 kg, reply to a@b.co',
    mustShow: 'rice',
    mustNotShow: 'halal',
  },
  { id: 's-2', text: 'Synthetic dates 500 g', mustShow: 'dates', mustNotShow: 'halal' },
];

const textOf = (turn: ModelTurn) =>
  turn.blocks
    .filter((block) => block.type === 'text')
    .map((block) => (block as { text: string }).text)
    .join('');

/** A suite as a module declares it, graded with a "guard" that strips tags and drops a leak. */
export class FakeSuite implements EvaluationSuite {
  setVersion = 'set-1';
  /** Builds a request with tools when set (a suite that must be refused). */
  withTools = false;
  /** Pads the request past the capability's input cap. */
  oversized = false;

  constructor(
    readonly capability: string,
    readonly samples: readonly FakeSample[] = FAKE_SAMPLES,
  ) {}

  #sample(id: string) {
    return this.samples.find((sample) => sample.id === id);
  }

  sampleIds() {
    return this.samples.map((sample) => sample.id);
  }

  label(id: string) {
    return this.#sample(id)?.text.slice(0, 20) ?? null;
  }

  request(id: string): ModelRequest | null {
    const sample = this.#sample(id);
    if (sample === undefined) return null;
    return {
      system: 'You write a product description.',
      messages: [
        {
          role: 'user',
          blocks: [{ type: 'text', text: this.oversized ? sample.text.repeat(2000) : sample.text }],
        },
      ],
      tools: this.withTools
        ? [{ name: 'search', description: 'search', inputSchema: { type: 'object' } }]
        : [],
      maxOutputTokens: 5000,
    };
  }

  display(_id: string, turn: ModelTurn): string | null {
    const text = textOf(turn)
      .replace(/<[^>]*>/g, '')
      .trim();
    return text === '' || /halal/i.test(text) ? null : text;
  }

  grade(id: string, turn: ModelTurn): EvaluationGrade {
    const sample = this.#sample(id)!;
    const raw = textOf(turn);
    const checks: EvaluationGrade['checks'][number][] = [];
    if (raw.toLowerCase().includes(sample.mustNotShow)) checks.push('leak');
    else if (raw.trim() === '') checks.push('empty');
    else if (!raw.toLowerCase().includes(sample.mustShow)) checks.push('missing-fact');
    return { passed: checks.length === 0, checks };
  }
}

export const answer = (
  text: string,
  usage = { inputTokens: 100, outputTokens: 20 },
): ModelTurn => ({
  blocks: [{ type: 'text', text }],
  stop: 'end',
  usage,
});

/** A provider that records every request and answers what `answer` gives. */
export class ScriptedProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];
  answer: (request: ModelRequest, signal: AbortSignal) => Promise<ModelTurn> = (request) => {
    const text = (request.messages[0]!.blocks[0] as { text: string }).text;
    return Promise.resolve(answer(`A fine ${text.includes('rice') ? 'rice' : 'dates'} pack.`));
  };

  call(_credentials: unknown, request: ModelRequest, signal: AbortSignal) {
    this.requests.push(request);
    return this.answer(request, signal);
  }
}

/**
 * Units one after another, as row locks would order them, so two calls in parallel (the
 * playground) each get a unit of their own; a unit opened inside another still throws (the
 * production unit of work tells them apart by async context as well).
 */
export class SerialUnitOfWork implements UnitOfWork {
  readonly #inside = new AsyncLocalStorage<true>();
  #tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly inner: UnitOfWork) {}

  run<T, E>(
    market: MarketContext,
    work: () => Promise<Result<T, E>>,
    options?: UnitOfWorkOptions,
  ): Promise<Result<T, E>> {
    if (this.#inside.getStore() === true) throw new NestedUnitOfWorkError();
    const next = this.#tail.then(() =>
      this.#inside.run(true, () => this.inner.run(market, work, options)),
    );
    this.#tail = next.catch(() => undefined);
    return next;
  }

  runOnce(): never {
    throw new Error('not used');
  }
}

const REAL_MARKETS = loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS);

/** Keys for AU and ZZ on the API route; `fast` is `model-fast` in both. */
const configOf = (killed: boolean, codes: readonly string[]) =>
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

export interface HarnessOptions {
  readonly killed?: boolean;
  /** Markets with an API key (default AU and ZZ). */
  readonly keyed?: readonly string[];
  readonly budget?: TestBudget;
  readonly extraRoutes?: readonly RouteRow[];
  /** Suites to register under `alpha` (default: both writers). */
  readonly suites?: readonly EvaluationSuite[];
}

/**
 * Everything of the evaluation side wired on in-memory stores: no model has a pass (an evaluation
 * needs none), AU and ZZ hold a key, the evaluation budget is 10 US dollars a month.
 */
export function evaluationHarness(options: HarnessOptions = {}) {
  const clock = new FixedClock(EVAL_NOW);
  const ids = new SequenceIdGenerator(clock);
  const markets = new MarketRegistry(new Map(REAL_MARKETS));
  const provider = new ScriptedProvider();
  const capabilities = new CapabilityRegistry();
  capabilities.register('alpha', EVAL_SPECS);
  capabilities.seal();
  const suites = new EvaluationSuiteRegistry(capabilities);
  suites.register(
    'alpha',
    options.suites ?? [new FakeSuite('alpha.seller-writer'), new FakeSuite('alpha.admin-writer')],
  );
  suites.seal();
  const { store: usageStore, unitOfWork: inner } = inMemoryAiUsage(markets, clock);
  const unitOfWork = new SerialUnitOfWork(inner);
  const usage = new AiUsage(unitOfWork, usageStore, clock, ids, markets);
  const catalogue = testRouteCatalogue(options.extraRoutes);
  const models = new ModelGateway(
    configOf(options.killed ?? false, options.keyed ?? ['AU', 'ZZ']),
    provider,
    catalogue,
  );
  const router = testRouter(catalogue, new EvaluationResults([]), models, markets, clock);
  const controls = TestAiGatewayControls.everywhere(
    options.budget ?? { evaluationMonthMicroUsd: 10_000_000 },
  );
  const gateway = new AiEvaluationGateway(
    models,
    capabilities,
    suites,
    usage,
    clock,
    router,
    controls,
  );
  const store = new InMemoryAiEvaluationStore();
  const control = new AiEvaluationControl(
    gateway,
    suites,
    store,
    usage,
    controls,
    unitOfWork,
    clock,
    ids,
  );
  const runner = new AiEvaluationRunner(unitOfWork, store, gateway, clock, ids, (market, at) =>
    usage.dayOf(market, at),
  );
  return {
    clock,
    ids,
    provider,
    capabilities,
    suites,
    usage,
    usageStore,
    unitOfWork,
    router,
    controls,
    gateway,
    store,
    control,
    runner,
  };
}

export function evalAdminContext(market: MarketContext, actingAs = false): CallContext {
  const actor = testAuthenticatedActor(market, {
    population: 'admin',
    accountId: ADMIN_ID as Id<'Account'>,
    sessionId: '01938a2b-4123-7456-8abc-00000000000d' as Id<'Session'>,
    sellerId: null,
  });
  const context = testCallContext(market, actor);
  return actingAs
    ? ({ ...context, actor: { ...actor, actingAs: { adminAccountId: ADMIN_ID } } } as never)
    : context;
}

export function evalSellerContext(market: MarketContext): CallContext {
  return testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'seller',
      accountId: '01938a2b-4123-7456-8abc-00000000000a' as Id<'Account'>,
      sessionId: '01938a2b-4123-7456-8abc-00000000000b' as Id<'Session'>,
      sellerId: '01938a2b-4123-7456-8abc-0123456789ab' as Id<'Seller'>,
    }),
  );
}
