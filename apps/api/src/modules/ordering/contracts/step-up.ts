import type { StepUpActionDeclaration } from '../../../platform/authz';

/**
 * The step-up actions ordering owns. All are admin actions: a platform admin presents a fresh
 * two-step code (`POST identity/admin/step-up/verify`) before the action, which is spent in the use
 * case's unit (ADR-0018).
 * - `ordering.ship-to-retention.change`: setting how long the sealed delivery address of a
 *   delivered order is kept (`PUT /ordering/admin/ship-to-retention`); switched on, a daily job
 *   deletes addresses for good (owner decision 2026-11-15).
 */
export const ORDERING_STEP_UP_ACTIONS: readonly StepUpActionDeclaration[] = [
  {
    key: 'ordering.ship-to-retention.change',
    defaultRequired: true,
    locked: true,
    audience: 'admin',
  },
];

export const ORDERING_SHIP_TO_RETENTION_STEP_UP = 'ordering.ship-to-retention.change';
