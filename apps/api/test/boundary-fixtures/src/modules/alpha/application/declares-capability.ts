import { CAPABILITY_TASKS } from '../../../platform/ai/capability';

// Violation (ai-capability-spec-only-from-contracts): a capability is declared only in the owning
// module's contracts/ai-capabilities.ts.
export const violation = CAPABILITY_TASKS;
