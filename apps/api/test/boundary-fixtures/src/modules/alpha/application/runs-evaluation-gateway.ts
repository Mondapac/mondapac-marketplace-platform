import { AiEvaluationGateway } from '../../../platform/ai/evaluations/evaluation-gateway';

// Violation (ai-evaluation-gateway-only-from-evaluations, model-entry-only-from-the-allow-list):
// only platform/ai/evaluations/ runs a sample on a model without a recorded pass.
export const violation = AiEvaluationGateway;
