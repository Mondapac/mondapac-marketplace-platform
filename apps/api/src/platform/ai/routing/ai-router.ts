import { Temporal } from '@mondapac/shared-kernel';
import type { Clock, MarketId } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../market-config/market-registry';
import type { CapabilitySpec } from '../capability';
import {
  priceOf,
  type ModelTokenPrice,
  type RouteCatalogue,
  type RouteRow,
} from '../catalogue/route-catalogue';
import type { EvaluationResults } from '../evaluations/evaluation-results';
import type { AiModelTier, ModelGateway } from '../model-gateway';
import { CircuitBreaker } from './circuit-breaker';

/** The most attempts one `run` makes, the first route included (design section 6). */
export const MAX_ATTEMPTS = 3;

/** One route the router may try, with the price its call is counted at. */
export interface PlannedRoute {
  readonly row: RouteRow;
  readonly price: ModelTokenPrice;
}

/**
 * The AI Gateway's router (docs/design/domain/platform-ai.md section 6; ADR-0052 decisions 2 to 5).
 * For a capability in a Market it builds the ordered list of routes a call may try: the task's
 * priority list of model families (until G4, the one family the module's tier names), saver mode
 * putting the Market's saver model first, and each family expanded to its catalogue rows, the
 * provider's own API first and the fallback route next. A row is kept only when it is usable now
 * (ADR-0052 decision 3): Hassan's no-retention and no-training check is recorded, its processing
 * region is one the Market's residency allows, the Market holds the route's key, it is not past its
 * retirement day, and (evaluation gate) the capability has a recorded pass for that provider,
 * family and the capability's current prompt version. No row left: the capability is off (R8).
 *
 * The circuit breaker sets a failing route aside per Market; the gateway asks it before each
 * attempt, so a plan is computed once per call and the breaker is read as the attempts go.
 */
export class AiRouter {
  readonly breaker: CircuitBreaker;

  constructor(
    private readonly catalogue: RouteCatalogue,
    private readonly evaluations: EvaluationResults,
    private readonly models: ModelGateway,
    private readonly markets: MarketRegistry,
    private readonly clock: Clock,
  ) {
    this.breaker = new CircuitBreaker(clock);
  }

  /**
   * The routes of a capability in the Market, in the order to try, at most {@link MAX_ATTEMPTS}.
   * `saver` puts the Market's saver model first when it is usable and cheaper than the first model.
   */
  plan(marketId: MarketId, spec: CapabilitySpec, tier: AiModelTier, saver = false): PlannedRoute[] {
    const first = this.models.modelOf(marketId, tier);
    if (first === null) return [];
    const families = [first];
    if (saver) {
      const saverModel = this.markets.get(marketId).aiRouting?.saverModel;
      if (saverModel !== undefined && saverModel !== first) {
        const saverRoutes = this.#usableRoutes(marketId, spec, saverModel);
        const firstRoutes = this.#usableRoutes(marketId, spec, first);
        if (
          saverRoutes.length > 0 &&
          (firstRoutes.length === 0 || costliest(saverRoutes) < costliest(firstRoutes))
        ) {
          families.unshift(saverModel);
        }
      }
    }
    return families
      .flatMap((family) => this.#usableRoutes(marketId, spec, family))
      .slice(0, MAX_ATTEMPTS);
  }

  /** The Market's saver threshold as a share (0.8 for 80 %), or null without a saver model. */
  saverThreshold(marketId: MarketId): number | null {
    const routing = this.markets.get(marketId).aiRouting;
    return routing?.saverModel === undefined ? null : routing.saverAtPercent / 100;
  }

  #usableRoutes(marketId: MarketId, spec: CapabilitySpec, family: string): PlannedRoute[] {
    return this.catalogue
      .routesOf(family)
      .filter((row) => this.#usable(marketId, spec, row))
      .map((row) => ({ row, price: priceOf(row) }));
  }

  #usable(marketId: MarketId, spec: CapabilitySpec, row: RouteRow): boolean {
    // Image input is not in the provider contract yet (section 5): no route serves `vision`.
    if (spec.task === 'vision') return false;
    if (row.dataTerms === null) return false;
    const routing = this.markets.get(marketId).aiRouting;
    if (routing === undefined || routing.dataResidency !== 'in-market-region') return false;
    if (row.region === null || !routing.regions.includes(row.region)) return false;
    if (!this.models.routeKeyConfigured(marketId, row.route)) return false;
    if (row.retiresOn !== null) {
      const today = this.clock.now().toZonedDateTimeISO('UTC').toPlainDate();
      if (Temporal.PlainDate.compare(today, Temporal.PlainDate.from(row.retiresOn)) > 0) {
        return false;
      }
    }
    return this.evaluationPassed(spec, row);
  }

  /**
   * The evaluation gate. The one exception (ADR-0052 decision 3: an evaluation run may use a row
   * without a pass) is a subclass under test/eval only, never an option the API could set
   * (Hassan, G3 review 3).
   */
  protected evaluationPassed(spec: CapabilitySpec, row: RouteRow): boolean {
    return this.evaluations.passed(spec.id, row.provider, row.family, spec.promptVersion);
  }
}

/** The dearer of the two prices of the most expensive route (per token, input and output). */
const costliest = (routes: readonly PlannedRoute[]): number =>
  Math.max(...routes.map((route) => route.price.inputPicoUsd + route.price.outputPicoUsd));

/**
 * The price an estimate is taken at: per side, the most expensive route of the plan (design
 * section 7), so a retry on a dearer route never passes a cap.
 */
export function planPrice(routes: readonly PlannedRoute[]): ModelTokenPrice | null {
  if (routes.length === 0) return null;
  return {
    inputPicoUsd: Math.max(...routes.map((route) => route.price.inputPicoUsd)),
    outputPicoUsd: Math.max(...routes.map((route) => route.price.outputPicoUsd)),
  };
}
