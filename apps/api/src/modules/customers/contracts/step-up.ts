import type { StepUpActionDeclaration } from '../../../platform/authz';

/**
 * The step-up actions customers owns (owner decision for package 5a). Changing the Market's
 * account deletion setting is an admin action: a platform admin presents a fresh two-step code
 * (`POST identity/admin/step-up/verify`) first. Guarded on `PUT
 * /customers/admin/account-deletion-settings` with `@RequiresStepUp` and spent again in
 * `setAccountDeletionSettings` in the unit of the change (ADR-0018), as the wallet switch does.
 */
export const CUSTOMERS_STEP_UP_ACTIONS: readonly StepUpActionDeclaration[] = [
  {
    key: 'customers.account-deletion-settings.change',
    defaultRequired: true,
    locked: true,
    audience: 'admin',
  },
];

export const ACCOUNT_DELETION_SETTINGS_CHANGE_STEP_UP =
  'customers.account-deletion-settings.change';
