import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  CUSTOMERS_CUSTOMER_EMAIL_CHANGE,
  CUSTOMERS_CUSTOMER_VIEW,
} from '../../contracts/permissions';
import {
  cancelEmailChange,
  type AdminEmailChangeCancelFailure,
  type EmailChangeDependencies,
} from '../admin-email-change-flow';

/**
 * `customers.admin-customer-email-change-cancel`: an admin cancels a customer's pending email
 * change (customers admin email change). The same rule and step-up as the request; identity clears
 * the pending address and voids the mailed link in one unit.
 */
export class AdminCustomerEmailChangeCancel extends UseCase<
  unknown,
  { readonly cancelled: true },
  AdminEmailChangeCancelFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-customer-email-change-cancel',
    rule: {
      kind: 'permissions',
      allOf: [CUSTOMERS_CUSTOMER_VIEW.key, CUSTOMERS_CUSTOMER_EMAIL_CHANGE.key],
    },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: EmailChangeDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<{ readonly cancelled: true }, AdminEmailChangeCancelFailure>> {
    return cancelEmailChange(this.deps, context, input);
  }
}
