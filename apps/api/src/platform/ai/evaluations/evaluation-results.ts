/**
 * The recorded real-model evaluation passes (ADR-0019 decision 9; docs/design/domain/platform-ai.md
 * section 6, "Evaluation gate"). A pass is bound to the capability, the provider, the model family
 * and the capability's prompt version; the router skips a model without a pass for the capability's
 * current prompt version, as primary and as fallback. A pass of a family holds on each of its
 * routes, because the route serves the same model (owner decision Q1).
 *
 * The passes live in `results.ts` beside this file, checked in: a pass is added only by PR, with the
 * evaluation report it rests on. A panel evaluation run (G4) yields a candidate only.
 */
export interface EvaluationPass {
  readonly capability: string;
  readonly provider: string;
  readonly family: string;
  readonly promptVersion: string;
  /** The day of the run, `YYYY-MM-DD`. */
  readonly passedOn: string;
  /** The run and its report (for example the Actions run of `assistant-eval.yml`). */
  readonly reference: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The passes, validated once at load; the router asks only {@link EvaluationResults.passed}. */
export class EvaluationResults {
  readonly #passes: ReadonlySet<string>;

  constructor(passes: readonly EvaluationPass[]) {
    const keys = new Set<string>();
    for (const pass of passes) {
      if (!DAY.test(pass.passedOn) || pass.reference.trim() === '') {
        throw new Error(
          `AI evaluation results: ${pass.capability} ${pass.family} needs a day and a reference`,
        );
      }
      keys.add(keyOf(pass.capability, pass.provider, pass.family, pass.promptVersion));
    }
    this.#passes = keys;
  }

  passed(capability: string, provider: string, family: string, promptVersion: string): boolean {
    return this.#passes.has(keyOf(capability, provider, family, promptVersion));
  }
}

const keyOf = (capability: string, provider: string, family: string, promptVersion: string) =>
  JSON.stringify([capability, provider, family, promptVersion]);

/** Nest token of the {@link EvaluationResults}; tests bind their own passes. */
export const AI_EVALUATION_RESULTS = Symbol('AI_EVALUATION_RESULTS');
