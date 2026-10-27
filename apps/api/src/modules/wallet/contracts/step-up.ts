import type { StepUpActionDeclaration } from '../../../platform/authz';

/**
 * The step-up actions wallet owns (issue #491). `wallet.settings.change` is an admin action: a
 * platform admin presents a fresh two-step code (`POST identity/admin/step-up/verify`) before
 * moving the Market's wallet switch. Guarded on `PUT /wallet/admin/settings` with
 * `@RequiresStepUp` and checked again in `setStatus` before the change (ADR-0018).
 */
export const WALLET_STEP_UP_ACTIONS: readonly StepUpActionDeclaration[] = [
  { key: 'wallet.settings.change', defaultRequired: true, locked: true, audience: 'admin' },
];

export const WALLET_SETTINGS_CHANGE_STEP_UP = 'wallet.settings.change';
