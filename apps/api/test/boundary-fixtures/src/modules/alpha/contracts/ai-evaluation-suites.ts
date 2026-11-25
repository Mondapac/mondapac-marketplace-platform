import type { EvaluationSuite } from '../../../platform/ai/evaluations/evaluation-suite';
import { violation as grader } from '../infrastructure/grades-with-an-adapter';

// Allowed: the suite port. Violation (ai-evaluation-suites-reach-no-application-or-infrastructure):
// a suite is built from its module's domain only, never an adapter.
export const suites: readonly EvaluationSuite[] = grader === null ? [] : [];
