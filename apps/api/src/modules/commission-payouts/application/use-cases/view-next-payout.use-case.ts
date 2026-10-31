import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { PayoutDependencies } from '../payout-dependencies';
import {
  viewNextPayout,
  type NextPayoutView,
  type SellerPayoutFailure,
} from '../payout-seller-flow';

export type { NextPayoutView };

/** `commission-payouts.view-next-payout`: the signed-in seller's estimated next payout, with the reason when it is not on its way (own resources). */
export class ViewNextPayout extends UseCase<void, NextPayoutView, SellerPayoutFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.view-next-payout',
    rule: { kind: 'own-resources' },
    // A seller whose access was suspended still sees why nothing is coming.
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PayoutDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return viewNextPayout(this.deps, context);
  }
}
