import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { COMMISSION_PAYOUTS_PAYOUT_APPROVE } from '../../contracts/permissions';
import type { PayoutDependencies } from '../payout-dependencies';
import { approvePayout, type ApprovedPayoutView, type PayoutFailure } from '../payout-admin-flow';

export type { ApprovedPayoutView };

type Input = { readonly payoutId: unknown; readonly amountMinor: unknown };

/** `commission-payouts.approve-payout`: an admin approves a waiting payout with the transfer amount they saw (protected key, step-up spent in the unit, audited). */
export class ApprovePayout extends UseCase<Input, ApprovedPayoutView, PayoutFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.approve-payout',
    rule: { kind: 'permissions', allOf: [COMMISSION_PAYOUTS_PAYOUT_APPROVE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PayoutDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return approvePayout(this.deps, context, input);
  }
}
