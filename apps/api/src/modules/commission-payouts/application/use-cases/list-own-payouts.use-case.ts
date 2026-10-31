import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { PayoutDependencies } from '../payout-dependencies';
import {
  listOwnPayouts,
  type OwnPayoutsView,
  type OwnPayoutView,
  type SellerPayoutFailure,
} from '../payout-seller-flow';

export type { OwnPayoutsView, OwnPayoutView };

type Input = { readonly cursor?: unknown; readonly limit?: unknown };

/** `commission-payouts.list-own-payouts`: the signed-in seller's payout history, newest first, voided ones hidden (own resources). */
export class ListOwnPayouts extends UseCase<Input, OwnPayoutsView, SellerPayoutFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.list-own-payouts',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PayoutDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return listOwnPayouts(this.deps, context, input);
  }
}
