import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { COMMISSION_PAYOUTS_PAYOUT_HOLD_PLACE } from '../../contracts/permissions';
import type { CommissionPayoutsDependencies } from '../commission-payouts-dependencies';
import { placePayoutHold, type HoldFailure, type PayoutHoldView } from '../hold-flow';

export type { PayoutHoldView };

type Input = {
  readonly sellerId: unknown;
  readonly sellerOrderId?: unknown;
  readonly reason: unknown;
};

/** `commission-payouts.place-payout-hold`: an admin places a payout hold with a reason code (protected key). */
export class PlacePayoutHold extends UseCase<Input, PayoutHoldView, HoldFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.place-payout-hold',
    rule: { kind: 'permissions', allOf: [COMMISSION_PAYOUTS_PAYOUT_HOLD_PLACE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CommissionPayoutsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return placePayoutHold(this.deps, context, input);
  }
}
