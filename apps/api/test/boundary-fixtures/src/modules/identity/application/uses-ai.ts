import { CAPABILITY_TASKS } from '../../../platform/ai/capability';

// Violation (no-ai-in-identity-payments-or-payouts): identity imports nothing from platform/ai
// (ADR-0019 R2). It also breaks the spec rule, since it is not a contracts file.
export const violation = CAPABILITY_TASKS;
