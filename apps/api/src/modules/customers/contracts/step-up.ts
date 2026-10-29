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
  // Package 5c: an admin deletes a buyer's account for them (and cancels such a request). Guarded
  // on both routes with `@RequiresStepUp` and spent in the unit of the request or the cancel.
  {
    key: 'customers.buyer-account.delete',
    defaultRequired: true,
    locked: true,
    audience: 'admin',
  },
];

export const ACCOUNT_DELETION_SETTINGS_CHANGE_STEP_UP =
  'customers.account-deletion-settings.change';

export const BUYER_ACCOUNT_DELETE_STEP_UP = 'customers.buyer-account.delete';
