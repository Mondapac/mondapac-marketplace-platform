import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { COMMISSION_PAYOUTS_PAYOUT_HOLD_RELEASE } from '../../contracts/permissions';
import type { CommissionPayoutsDependencies } from '../commission-payouts-dependencies';
import { releasePayoutHold, type HoldFailure, type PayoutHoldView } from '../hold-flow';

export type { PayoutHoldView };

type Input = { readonly holdId: unknown; readonly reason: unknown };

/** `commission-payouts.release-payout-hold`: an admin releases any payout hold, `seller-suspended` included, with a reason code (protected key). */
export class ReleasePayoutHold extends UseCase<Input, PayoutHoldView, HoldFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.release-payout-hold',
    rule: { kind: 'permissions', allOf: [COMMISSION_PAYOUTS_PAYOUT_HOLD_RELEASE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CommissionPayoutsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return releasePayoutHold(this.deps, context, input);
  }
}
