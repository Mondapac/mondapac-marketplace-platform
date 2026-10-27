import type { StepUpActionDeclaration } from '../../../platform/authz';

/**
 * The step-up actions commission-payouts owns (packages 6b and its review fix). All are admin
 * actions: a platform admin presents a fresh two-step code (`POST identity/admin/step-up/verify`)
 * before setting or removing a seller's commission rate, changing a seller's payout terms, or
 * placing or releasing a payout hold. Guarded on the routes with `@RequiresStepUp`;
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
];
