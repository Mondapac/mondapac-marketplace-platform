import type { EvaluationPass } from './evaluation-results';

/**
 * Recorded real-model evaluation passes (see `evaluation-results.ts`). Empty: no capability has a
 * recorded pass yet, so the router finds no model for any capability and every capability stays
 * off (R8) until a pass is added here by PR with its report.
 */
export const EVALUATION_PASSES: readonly EvaluationPass[] = [];
