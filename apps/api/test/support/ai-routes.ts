import { Temporal } from '@mondapac/shared-kernel';
import type { Clock } from '@mondapac/shared-kernel';
import { CapabilityRegistry } from '../../src/platform/ai/capability-registry';
import { EvaluationSuiteRegistry } from '../../src/platform/ai/evaluations/evaluation-suite';
import { InHouseRollback } from '../../src/platform/ai/own-model/in-house-rollback';
import {
  InHouseRollout,
  type InHouseHealthCheck,
} from '../../src/platform/ai/own-model/in-house-rollout';
import { InMemoryAiUsageStore, InMemoryAiUsageUnitOfWork, testIds } from './in-memory-ai-usage';
import { InHouseShadow, type ShadowSampler } from '../../src/platform/ai/own-model/in-house-shadow';
import type { ShadowApprovals } from '../../src/platform/ai/own-model/in-house-stage';
import type { CapabilitySpec } from '../../src/platform/ai/capability';
import {
  RouteCatalogue,
  type RouteKind,
  type RouteRow,
} from '../../src/platform/ai/catalogue/route-catalogue';
import {
  EvaluationResults,
  type EvaluationPass,
} from '../../src/platform/ai/evaluations/evaluation-results';
import type { ModelGateway } from '../../src/platform/ai/model-gateway';
import { AiRouter } from '../../src/platform/ai/routing/ai-router';
import type { MarketRegistry } from '../../src/platform/market-config/market-registry';

/** Hassan's check as a test row records it. */
export const TEST_DATA_TERMS = {
  noRetention: true,
  noTraining: true,
  checkedOn: '2026-11-25',
  reference: 'test fixture',
  reviewer: 'test',
} as const;

/**
 * A usable test row: verified, in Sydney (the region AU and the ZZ fixture allow), priced
 * 1 / 5 US dollars per million tokens unless given.
 */
export function testRoute(
  family: string,
  route: RouteKind = 'anthropic-api',
  overrides: Partial<RouteRow> = {},
): RouteRow {
  const model = route === 'anthropic-api' ? family : `anthropic.${family}`;
  return {
    id: `${route}/${model}`,
    provider: 'anthropic',
    route,
    family,
    model,
    region: 'ap-southeast-2',
    dataTerms: TEST_DATA_TERMS,
    inputUsdPerMTok: 1,
    outputUsdPerMTok: 5,
    retiresOn: null,
    ...overrides,
  };
}

/** The test catalogue: `model-fast` and `model-balanced` on both routes, all usable. */
export function testRouteCatalogue(extra: readonly RouteRow[] = []): RouteCatalogue {
  return new RouteCatalogue([
    testRoute('model-fast'),
    testRoute('model-fast', 'bedrock-mantle'),
    testRoute('model-balanced', 'anthropic-api', { inputUsdPerMTok: 3, outputUsdPerMTok: 15 }),
    ...extra,
  ]);
}

/** A pass for every capability of the specs on the given families. */
export function passesFor(
  specs: readonly CapabilitySpec[],
  families: readonly string[] = ['model-fast', 'model-balanced'],
): EvaluationResults {
  const passes: EvaluationPass[] = specs.flatMap((spec) =>
    families.map((family) => ({
      capability: spec.id,
      provider: 'anthropic',
      family,
      promptVersion: spec.promptVersion,
      passedOn: '2026-11-25',
      reference: 'test fixture',
    })),
  );
  return new EvaluationResults(passes);
}

export function testRouter(
  catalogue: RouteCatalogue,
  evaluations: EvaluationResults,
  models: ModelGateway,
  markets: MarketRegistry,
  clock: Clock,
): AiRouter {
  return new AiRouter(catalogue, evaluations, models, markets, clock);
}

/**
 * The gateway's shadow runner for a unit test (G6c): by default no Market has the owner's approval
 * and no call is sampled, so no shadow call is sent. A test of shadow passes its approvals, the
 * suites it registered and a sampler.
 */
export function testShadow(
  router: AiRouter,
  options: {
    readonly capabilities?: CapabilityRegistry;
    readonly suites?: EvaluationSuiteRegistry;
    readonly approvals?: ShadowApprovals;
    readonly sampler?: ShadowSampler;
  } = {},
): InHouseShadow {
  const suites =
    options.suites ?? new EvaluationSuiteRegistry(options.capabilities ?? new CapabilityRegistry());
  return new InHouseShadow(
    router,
    suites,
    options.approvals ?? {},
    options.sampler ?? { take: () => false },
  );
}

/**
 * The gateway's percent and default stages for a unit test (G6d2): by default no in-house row is
 * healthy and no call is in the percent share, so no live call reaches the in-house model. A test
 * of the live stages passes its health, sampler and suites.
 */
export function testRollout(
  router: AiRouter,
  options: {
    readonly capabilities?: CapabilityRegistry;
    readonly suites?: EvaluationSuiteRegistry;
    readonly approvals?: ShadowApprovals;
    readonly health?: InHouseHealthCheck;
    readonly sampler?: ShadowSampler;
  } = {},
): InHouseRollout {
  const suites =
    options.suites ?? new EvaluationSuiteRegistry(options.capabilities ?? new CapabilityRegistry());
  return new InHouseRollout(
    router,
    suites,
    options.health ?? { healthy: () => false },
    options.approvals ?? {},
    options.sampler ?? { take: () => false },
  );
}

/**
 * The gateway's auto-rollback for a unit test (G6d3): on the test's in-memory usage store when
 * given (so a test sees the rows it judges), else on a store of its own with no rollback.
 */
export function testRollback(
  router: AiRouter,
  options: {
    readonly store?: InMemoryAiUsageStore;
    readonly clock?: Clock;
    readonly capabilities?: CapabilityRegistry;
  } = {},
): InHouseRollback {
  const store = options.store ?? new InMemoryAiUsageStore();
  return new InHouseRollback(
    new InMemoryAiUsageUnitOfWork(store),
    store,
    options.clock ?? { now: () => Temporal.Now.instant() },
    testIds,
    router,
    options.capabilities ?? new CapabilityRegistry(),
  );
}

/** A usable in-house test row (G6a): the `mondapac` provider on `in-house-http`, in Sydney. */
export function testInHouseRoute(family: string, overrides: Partial<RouteRow> = {}): RouteRow {
  const model = `${family}-v1`;
  return {
    id: `in-house-http/${model}`,
    provider: 'mondapac',
    route: 'in-house-http',
    family,
    model,
    region: 'ap-southeast-2',
    dataTerms: TEST_DATA_TERMS,
    inputUsdPerMTok: 0.2,
    outputUsdPerMTok: 1,
    retiresOn: null,
    endpoint: 'https://intelligence.example.com/model',
    ...overrides,
  };
}
