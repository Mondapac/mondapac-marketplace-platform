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
 * `payments.open-payout-account-link`: a new hosted page for an account that exists: onboarding
 * until the account is enabled, update afterwards. Same rule as connecting; it never creates an
 * account.
 */
export class OpenPayoutAccountLink extends UseCase<
  Record<string, never>,
  PayoutAccountLink,
  PayoutAccountFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'payments.open-payout-account-link',
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
    return openPayoutAccountLink(this.deps, context, false);
  }
}
