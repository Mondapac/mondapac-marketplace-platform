import { AI_USAGE_STORE } from '../../../platform/ai/usage/ai-usage-store';

// Violation (ai-usage-store-only-in-persistence): only platform/persistence/ai-usage/ implements
// the AI budget store.
export const violation = AI_USAGE_STORE;
