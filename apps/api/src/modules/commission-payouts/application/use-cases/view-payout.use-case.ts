import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { COMMISSION_PAYOUTS_PAYOUT_VIEW } from '../../contracts/permissions';
import type { PayoutDependencies } from '../payout-dependencies';
import { viewPayout, type PayoutDetailView, type PayoutFailure } from '../payout-admin-flow';

export type { PayoutDetailView };

type Input = { readonly payoutId: unknown };

/** `commission-payouts.view-payout`: an admin reads one payout with its seller orders, the account's readiness and the transfer limits. */
export class ViewPayout extends UseCase<Input, PayoutDetailView, PayoutFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'commission-payouts.view-payout',
    rule: { kind: 'permissions', allOf: [COMMISSION_PAYOUTS_PAYOUT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PayoutDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return viewPayout(this.deps, context, input);
  }
}
