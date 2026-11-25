import type { Clock } from '@mondapac/shared-kernel';
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
 * The router of an evaluation run (ADR-0052 decision 3, the one exception): a row that meets every
 * other condition may be used without a recorded evaluation pass. It lives under test/ so the API
 * can never build it (Hassan, G3 review 3).
 */
export class EvaluationRunRouter extends AiRouter {
  protected override evaluationPassed(): boolean {
    return true;
  }
}
