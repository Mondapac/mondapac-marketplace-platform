import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { COMMISSION_PAYOUTS_RATE_EDIT } from '../../contracts/permissions';
import type { CommissionPayoutsDependencies } from '../commission-payouts-dependencies';
import { setCommissionRate, type RateChangeView, type RateFailure } from '../rate-flow';

interface Input {
  readonly sellerId: unknown;
  readonly rateBps: unknown;
  /** The admin's note for the System requests review (needed where area money is reviewed). */
  readonly note?: unknown;
}

/** `commission-payouts.set-commission-rate`: an admin sets a seller's own rate (protected key). */
export class SetCommissionRate extends UseCase<Input, RateChangeView, RateFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.set-commission-rate',
    rule: { kind: 'permissions', allOf: [COMMISSION_PAYOUTS_RATE_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CommissionPayoutsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return setCommissionRate(this.deps, context, input);
  }
}
