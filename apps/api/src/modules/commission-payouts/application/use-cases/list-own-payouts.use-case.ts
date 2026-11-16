import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  listOwnPayoutPage,
  type OwnPayoutListDependencies,
  type OwnPayoutListFailure,
  type OwnPayoutListPage,
} from '../own-payout-list-flow';
import type { OwnPayoutsView, OwnPayoutView } from '../payout-seller-flow';

export type { OwnPayoutListPage, OwnPayoutsView, OwnPayoutView };

type Input = Readonly<Record<string, unknown>>;

/**
 * `commission-payouts.list-own-payouts`: the signed-in seller's payout history as the Earnings
 * super list (list 33), voided ones hidden (own resources).
 */
export class ListOwnPayouts extends UseCase<Input, OwnPayoutListPage, OwnPayoutListFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.list-own-payouts',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnPayoutListDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return listOwnPayoutPage(this.deps, context, input);
  }
}
