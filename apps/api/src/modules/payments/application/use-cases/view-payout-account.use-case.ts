import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PAYMENTS_PAYOUT_ACCOUNT_VIEW } from '../../contracts/permissions';
import {
  viewPayoutAccount,
  type PayoutAccountFailure,
  type PayoutAccountView,
} from '../connect-flow';
import type { PaymentsDependencies } from '../payments-dependencies';

/**
 * `payments.view-payout-account`: the state of the acting seller's own payout account, from the
 * stored row (no call to Stripe). Rule `permissions [payments.payout-account.view]`. Allowed
 * while the seller is not yet approved, so the panel can show "not connected".
 */
export class ViewPayoutAccount extends UseCase<
  Record<string, never>,
  PayoutAccountView,
  PayoutAccountFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'payments.view-payout-account',
    rule: { kind: 'permissions', allOf: [PAYMENTS_PAYOUT_ACCOUNT_VIEW.key] },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PaymentsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return viewPayoutAccount(this.deps, context);
  }
}
