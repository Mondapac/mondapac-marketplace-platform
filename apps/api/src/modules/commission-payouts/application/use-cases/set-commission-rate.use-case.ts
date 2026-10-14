import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { COMMISSION_PAYOUTS_RATE_EDIT } from '../../contracts/permissions';
import type { CommissionPayoutsDependencies } from '../commission-payouts-dependencies';
import { setCommissionRate, type RateFailure, type RateView } from '../rate-flow';

interface Input {
  readonly sellerId: unknown;
  readonly rateBps: unknown;
}

/** `commission-payouts.set-commission-rate`: an admin sets a seller's own rate (protected key). */
export class SetCommissionRate extends UseCase<Input, RateView, RateFailure> {
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
