import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { COMMISSION_PAYOUTS_SETTLEMENT_VIEW } from '../../contracts/permissions';
import type { CommissionPayoutsDependencies } from '../commission-payouts-dependencies';
import { listPayoutHolds, type HoldFailure, type PayoutHoldView } from '../hold-flow';

export type { PayoutHoldView };

type Input = { readonly sellerId: unknown };

/** `commission-payouts.list-seller-payout-holds`: an admin lists a seller's payout holds, active ones first. */
export class ListSellerPayoutHolds extends UseCase<Input, readonly PayoutHoldView[], HoldFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.list-seller-payout-holds',
    rule: { kind: 'permissions', allOf: [COMMISSION_PAYOUTS_SETTLEMENT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CommissionPayoutsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return listPayoutHolds(this.deps, context, input);
  }
}
