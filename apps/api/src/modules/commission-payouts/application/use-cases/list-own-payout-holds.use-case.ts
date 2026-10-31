import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { PayoutDependencies } from '../payout-dependencies';
import {
  listOwnPayoutHolds,
  type OwnHeldView,
  type SellerPayoutFailure,
} from '../payout-seller-flow';

export type { OwnHeldView };

/** `commission-payouts.list-own-payout-holds`: the signed-in seller's money that is not yet payable, per seller order, with a reason and the date it is available from (own resources; no admin note). */
export class ListOwnPayoutHolds extends UseCase<void, readonly OwnHeldView[], SellerPayoutFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.list-own-payout-holds',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PayoutDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return listOwnPayoutHolds(this.deps, context);
  }
}
