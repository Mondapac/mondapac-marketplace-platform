import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PAYMENTS_PAYOUT_ACCOUNT_MANAGE } from '../../contracts/permissions';
import {
  openPayoutAccountLink,
  type PayoutAccountFailure,
  type PayoutAccountLink,
} from '../connect-flow';
import type { PaymentsDependencies } from '../payments-dependencies';

/**
 * `payments.connect-payout-account`: creates the seller's Stripe account when it has none and
 * returns the hosted onboarding page. Rule `permissions [payments.payout-account.manage]`
 * (protected, so the Seller Owner), approved sellers only. The seller is the session's, never
 * request input.
 */
export class ConnectPayoutAccount extends UseCase<
  Record<string, never>,
  PayoutAccountLink,
  PayoutAccountFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'payments.connect-payout-account',
    rule: { kind: 'permissions', allOf: [PAYMENTS_PAYOUT_ACCOUNT_MANAGE.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PaymentsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return openPayoutAccountLink(this.deps, context, true);
  }
}
