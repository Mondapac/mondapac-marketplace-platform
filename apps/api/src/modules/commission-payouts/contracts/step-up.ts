import type { StepUpActionDeclaration } from '../../../platform/authz';

/**
 * The step-up actions commission-payouts owns (package 6b, its review fix and package 8b). All
 * are admin actions: a platform admin presents a fresh two-step code
 * (`POST identity/admin/step-up/verify`) before setting or removing a seller's commission rate,
 * changing a seller's payout terms, placing or releasing a payout hold, deciding who bears a
 * lost chargeback, or approving a payout. Guarded on the routes with `@RequiresStepUp`;
 * the guard refuses an acting-as session. The keys are those of the protected permissions.
 */
export const COMMISSION_PAYOUTS_STEP_UP_ACTIONS: readonly StepUpActionDeclaration[] = [
  {
    key: 'commission-payouts.commission-rate.edit',
    defaultRequired: true,
    locked: true,
    audience: 'admin',
  },
  {
    key: 'commission-payouts.payout-terms.edit',
    defaultRequired: true,
    locked: true,
    audience: 'admin',
  },
  {
    key: 'commission-payouts.payout-hold.place',
    defaultRequired: true,
    locked: true,
    audience: 'admin',
  },
  {
    key: 'commission-payouts.payout-hold.release',
    defaultRequired: true,
    locked: true,
    audience: 'admin',
  },
  {
    key: 'commission-payouts.dispute.attribute',
    defaultRequired: true,
    locked: true,
    audience: 'admin',
  },
  {
    key: 'commission-payouts.payout.approve',
    defaultRequired: true,
    locked: true,
    audience: 'admin',
  },
];
