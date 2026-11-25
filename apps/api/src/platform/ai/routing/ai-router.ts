import { Temporal } from '@mondapac/shared-kernel';
import type { Clock, MarketId } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../market-config/market-registry';
import type { CapabilitySpec, CapabilityTask } from '../capability';
import { NO_MODEL_LISTS, type AiModelLists } from '../gateway-controls';
import {
  priceOf,
  type ModelTokenPrice,
  type RouteCatalogue,
  type RouteRow,
} from '../catalogue/route-catalogue';
import type { EvaluationResults } from '../evaluations/evaluation-results';
import type { AiModelTier, ModelGateway } from '../model-gateway';
import { CircuitBreaker } from './circuit-breaker';

/** Why a model cannot be chosen or called (design section 8, server checks). */
export type RouteProblem =
  | 'unknown-model'
  | 'task-unsupported'
  | 'not-checked'
  | 'region'
  | 'no-key'
  | 'retired'
  | 'not-evaluated';

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
 * priority list of model families (the Market's list for the task type, G4b; without one, the
 * family the module's tier names), saver mode putting the task's saver model first, and each family expanded to its catalogue rows, the
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
   * The routes of a capability in the Market, in the order to try, at most {@link MAX_ATTEMPTS}:
   * the Market's priority list for the capability's task type (G4b settings), or, while the Market
   * has none, the one family its tier names. `saver` puts the task's saver model first when it is
   * usable and cheaper than the first model.
   */
  plan(
    marketId: MarketId,
    spec: CapabilitySpec,
    tier: AiModelTier,
    saver = false,
    models: AiModelLists = NO_MODEL_LISTS,
  ): PlannedRoute[] {
    const chosen = models.lists[spec.task] ?? [];
    const families: string[] = [...chosen];
    if (families.length === 0) {
      const tierFamily = this.models.modelOf(marketId, tier);
      if (tierFamily !== null) families.push(tierFamily);
    }
    if (families.length === 0) return [];
    const first = families[0]!;
    if (saver) {
      const saverModel = models.savers[spec.task];
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
    return [...new Set(families)]
      .flatMap((family) => this.#usableRoutes(marketId, spec, family))
      .slice(0, MAX_ATTEMPTS);
  }

  /** The task's saver threshold as a share (0.8 for 80 %), or null without a saver model. */
  saverThreshold(spec: CapabilitySpec, models: AiModelLists): number | null {
    return models.savers[spec.task] === undefined ? null : models.saverAtPercent / 100;
  }

  /**
   * Why a family cannot be chosen for a task type in the Market now (the server checks of the
   * External models tab, design sections 7 and 8), or null. A family qualifies when, for every
   * capability of the task type (`specs`), at least one of its routes is usable; with no capability
   * of the task type yet, when one of its routes meets every condition but the evaluation. The
   * reason given is the provider's own route's.
   */
  familyProblem(
    marketId: MarketId,
    task: CapabilityTask,
    specs: readonly CapabilitySpec[],
    family: string,
  ): RouteProblem | null {
    const rows = this.catalogue.routesOf(family);
    if (rows.length === 0) return 'unknown-model';
    if (specs.length === 0) {
      const problems = rows.map((row) => this.#rowProblem(marketId, task, row));
      return problems.includes(null) ? null : problems[0]!;
    }
    for (const spec of specs) {
      const problems = rows.map((row) => this.routeProblem(marketId, spec, row));
      if (!problems.includes(null)) return problems[0]!;
    }
    return null;
  }

  /** Every model family of the route catalogue, sorted. */
  families(): string[] {
    return this.catalogue.families();
  }

  /**
   * The most expensive price per token (input and output) of a family's routes that meet every
   * condition but the evaluation in the Market for the task type, as `plan` prices them; null with
   * none (Mohammad, G4b review 3).
   */
  familyCost(marketId: MarketId, task: CapabilityTask, family: string): number | null {
    const rows = this.catalogue
      .routesOf(family)
      .filter((row) => this.#rowProblem(marketId, task, row) === null);
    return rows.length === 0 ? null : costliest(rows.map((row) => ({ row, price: priceOf(row) })));
  }

  /**
   * The routes of an evaluation or playground call (G4c; ADR-0052 decision 3, the one exception):
   * only `family` of `provider`, every row that meets every condition but the evaluation pass
   * (Hassan's check, the Market's region, a key, not retired; no vision), provider route first, at
   * most {@link MAX_ATTEMPTS}. The Market's lists and saver model play no part: the run measures
   * this one model. Used only by the evaluation gateway, with the evaluation suites' synthetic
   * samples; `plan` never takes a row without a pass.
   */
  evaluationPlan(
    marketId: MarketId,
    spec: CapabilitySpec,
    provider: string,
    family: string,
  ): PlannedRoute[] {
    return this.catalogue
      .routesOf(family)
      .filter(
        (row) => row.provider === provider && this.#rowProblem(marketId, spec.task, row) === null,
      )
      .map((row) => ({ row, price: priceOf(row) }))
      .slice(0, MAX_ATTEMPTS);
  }

  /**
   * Why {@link evaluationPlan} is empty for the capability, or null when it is not: the problem of
   * the family's first route of `provider` (`unknown-model` when it has none).
   */
  evaluationProblem(
    marketId: MarketId,
    spec: CapabilitySpec,
    provider: string,
    family: string,
  ): RouteProblem | null {
    const rows = this.catalogue.routesOf(family).filter((row) => row.provider === provider);
    if (rows.length === 0) return 'unknown-model';
    const problems = rows.map((row) => this.#rowProblem(marketId, spec.task, row));
    return problems.includes(null) ? null : problems[0]!;
  }

  /** The provider of a catalogue family (every route of a family serves one model), or null. */
  providerOf(family: string): string | null {
    return this.catalogue.routesOf(family)[0]?.provider ?? null;
  }

  #usableRoutes(marketId: MarketId, spec: CapabilitySpec, family: string): PlannedRoute[] {
    return this.catalogue
      .routesOf(family)
      .filter((row) => this.#usable(marketId, spec, row))
      .map((row) => ({ row, price: priceOf(row) }));
  }

  #usable(marketId: MarketId, spec: CapabilitySpec, row: RouteRow): boolean {
    return this.routeProblem(marketId, spec, row) === null;
  }

  /** Why a route row is not usable for the capability in the Market now, or null (ADR-0052 d3). */
  routeProblem(marketId: MarketId, spec: CapabilitySpec, row: RouteRow): RouteProblem | null {
    const problem = this.#rowProblem(marketId, spec.task, row);
    if (problem !== null) return problem;
    return this.#evaluationPassed(spec, row) ? null : 'not-evaluated';
  }

  /** Every condition of ADR-0052 decision 3 but the evaluation, for a task type in the Market. */
  #rowProblem(marketId: MarketId, task: CapabilityTask, row: RouteRow): RouteProblem | null {
    // Image input is not in the provider contract yet (section 5): no route serves `vision`.
    if (task === 'vision') return 'task-unsupported';
    if (row.dataTerms === null) return 'not-checked';
    const routing = this.markets.get(marketId).aiRouting;
    if (routing === undefined || routing.dataResidency !== 'in-market-region') return 'region';
    if (row.region === null || !routing.regions.includes(row.region)) return 'region';
    if (!this.models.routeKeyConfigured(marketId, row.route)) return 'no-key';
    if (row.retiresOn !== null) {
      const today = this.clock.now().toZonedDateTimeISO('UTC').toPlainDate();
      if (Temporal.PlainDate.compare(today, Temporal.PlainDate.from(row.retiresOn)) > 0) {
        return 'retired';
      }
    }
    return null;
  }

  /**
   * The evaluation gate. Private, so no subclass lifts it: the one exception (ADR-0052 decision
   * 3: an evaluation run may use a row without a pass) is {@link evaluationPlan}, which only the
   * evaluation gateway calls, never an option `plan` could take (Hassan, G3 review 3; G4c).
   */
  #evaluationPassed(spec: CapabilitySpec, row: RouteRow): boolean {
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
