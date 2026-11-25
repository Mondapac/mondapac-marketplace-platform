import { Injectable } from '@nestjs/common';
import type { MarketId } from '@mondapac/shared-kernel';
import { CAPABILITY_TASKS, type CapabilitySpec, type CapabilityTask } from './capability';
import { CapabilityRegistry } from './capability-registry';
import { AiRouter, MAX_ATTEMPTS, type RouteProblem } from './routing/ai-router';

/**
 * Why a model cannot take its place in a task type's list: a route problem (unknown family, not
 * checked by Hassan, region, key, retired, not evaluated, task unsupported), the family twice, a
 * list longer than {@link MAX_ATTEMPTS}, or a saver model that is not cheaper than model 1 or has no
 * list to go before.
 */
export type ModelChoiceProblem =
  RouteProblem | 'duplicate' | 'too-many' | 'saver-not-cheaper' | 'saver-without-list';

/** A model family and why it cannot be chosen for the task type now (null: it can). */
export interface ModelOption {
  readonly family: string;
  readonly problem: RouteProblem | null;
}

/** The problems of one task type's choice: per list position, and the saver model's. */
export interface ModelChoiceCheck {
  readonly list: readonly (ModelChoiceProblem | null)[];
  readonly saver: ModelChoiceProblem | null;
}

/**
 * The server checks of the External models tab (docs/design/domain/platform-ai.md sections 7 and
 * 8; AI Gateway G4b), for `settings`, which owns the lists (ADR-0042) and refuses a change that
 * fails them. A family enters a task type's list only when it is in the route catalogue and, for
 * every registered capability of that task type, one of its routes is usable in the Market now
 * (Hassan's check, the Market's region, a key, not retired, evaluated; ADR-0052 decision 3). The
 * saver model meets the same checks and is cheaper than model 1. The router checks every route
 * again on each call, so a list that went stale (a retired model, a key removed) only skips it.
 * These checks are the page's: two admins saving the list and the saver model at once, or a
 * review that restores one of them, can leave a pair they would refuse; the router still puts a
 * saver model first only when it is usable and cheaper (Hassan 1 and 3, Mohammad 4, G4b review).
 *
 * Reads code and configuration only (the catalogue, the evaluation passes, the Market's residency
 * and keys): no store, no model call, no secret in its answer. This file calls no model, so
 * `settings` may import it (boundary rule `ai-model-choices-only-from-settings`).
 */
@Injectable()
export class AiModelChoices {
  constructor(
    private readonly router: AiRouter,
    private readonly capabilities: CapabilityRegistry,
  ) {}

  /** Every catalogue family per task type, with why it cannot be chosen in the Market now. */
  options(marketId: MarketId): Readonly<Record<CapabilityTask, readonly ModelOption[]>> {
    const families = this.router.families();
    const options = {} as Record<CapabilityTask, readonly ModelOption[]>;
    for (const task of CAPABILITY_TASKS) {
      const specs = this.#specsOf(task);
      options[task] = families.map((family) => ({
        family,
        problem: this.router.familyProblem(marketId, task, specs, family),
      }));
    }
    return options;
  }

  /** The problems of a task type's list and saver model (null: none chosen) in the Market. */
  check(
    marketId: MarketId,
    task: CapabilityTask,
    list: readonly string[],
    saver: string | null,
  ): ModelChoiceCheck {
    const specs = this.#specsOf(task);
    const seen = new Set<string>();
    const listProblems = list.map((family, index): ModelChoiceProblem | null => {
      if (index >= MAX_ATTEMPTS) return 'too-many';
      if (seen.has(family)) return 'duplicate';
      seen.add(family);
      return this.router.familyProblem(marketId, task, specs, family);
    });
    return { list: listProblems, saver: this.#saverProblem(marketId, task, specs, list, saver) };
  }

  #saverProblem(
    marketId: MarketId,
    task: CapabilityTask,
    specs: readonly CapabilitySpec[],
    list: readonly string[],
    saver: string | null,
  ): ModelChoiceProblem | null {
    if (saver === null) return null;
    const first = list[0];
    if (first === undefined) return 'saver-without-list';
    const problem = this.router.familyProblem(marketId, task, specs, saver);
    if (problem !== null) return problem;
    const saverCost = this.router.familyCost(marketId, task, saver);
    const firstCost = this.router.familyCost(marketId, task, first);
    if (saverCost === null || firstCost === null || saverCost >= firstCost) {
      return 'saver-not-cheaper';
    }
    return null;
  }

  #specsOf(task: CapabilityTask): CapabilitySpec[] {
    return this.capabilities
      .ids()
      .map((id) => this.capabilities.get(id)!)
      .filter((spec) => spec.task === task);
  }
}
