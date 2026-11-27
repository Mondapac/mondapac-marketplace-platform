import { InHouseRollbackStatusRead } from '../../../platform/ai/own-model/in-house-rollback-status';

// Violation (ai-in-house-rollback-status-only-from-settings): only settings reads the in-house
// model's latest auto-rollbacks.
export const violation = InHouseRollbackStatusRead;
