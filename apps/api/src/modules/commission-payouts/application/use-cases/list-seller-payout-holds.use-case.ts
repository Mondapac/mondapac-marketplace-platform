import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { COMMISSION_PAYOUTS_SETTLEMENT_VIEW } from '../../contracts/permissions';
import type { PayoutHoldView } from '../hold-flow';
import {
  listSellerHolds,
  type SellerHoldPage,
  type SellerPageListDependencies,
  type SellerPageListFailure,
} from '../seller-page-lists-flow';

export type { PayoutHoldView, SellerHoldPage };

type Input = Readonly<Record<string, unknown>>;

/**
 * `commission-payouts.list-seller-payout-holds`: an admin lists a seller's payout holds, active
 * ones first, as the compact super list of the seller page (list 28).
 */
export class ListSellerPayoutHolds extends UseCase<Input, SellerHoldPage, SellerPageListFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.list-seller-payout-holds',
    rule: { kind: 'permissions', allOf: [COMMISSION_PAYOUTS_SETTLEMENT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellerPageListDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return listSellerHolds(this.deps, context, input);
  }
}
