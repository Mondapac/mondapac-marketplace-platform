import type { StepUpActionDeclaration } from '../../../platform/authz';

/**
 * The step-up actions wallet owns (issue #491; package 2a). All are admin actions. `wallet.settings.change`: a
 * platform admin presents a fresh two-step code (`POST identity/admin/step-up/verify`) before
 * moving the Market's wallet switch. Guarded on `PUT /wallet/admin/settings` with
 * `@RequiresStepUp` and checked again in `setStatus` before the change (ADR-0018).
 */
export const WALLET_STEP_UP_ACTIONS: readonly StepUpActionDeclaration[] = [
  { key: 'wallet.credit.approve', defaultRequired: true, locked: true, audience: 'admin' },
  { key: 'wallet.credit.issue', defaultRequired: true, locked: true, audience: 'admin' },
  { key: 'wallet.settings.change', defaultRequired: true, locked: true, audience: 'admin' },
];

export const WALLET_SETTINGS_CHANGE_STEP_UP = 'wallet.settings.change';

/**
 * Issuing store credit (package 2a): guarded on `POST /wallet/admin/credits` and spent in
 * `IssueAdminCredit` in the unit that grants the credit or files the request.
 */
export const WALLET_CREDIT_ISSUE_STEP_UP = 'wallet.credit.issue';

/**
 * Deciding another admin's credit request (package 2a): guarded on the approve and reject routes
 * and spent in `ApproveAdminCredit` and `RejectAdminCredit` in the unit that decides it.
 */
export const WALLET_CREDIT_APPROVE_STEP_UP = 'wallet.credit.approve';
