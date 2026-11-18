import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  CUSTOMERS_CUSTOMER_EMAIL_CHANGE,
  CUSTOMERS_CUSTOMER_VIEW,
} from '../../contracts/permissions';
import {
  requestEmailChange,
  type EmailChangeDependencies,
  type AdminEmailChangeRequested,
  type AdminEmailChangeRequestFailure,
} from '../admin-email-change-flow';

/**
 * `customers.admin-customer-email-change-request`: an admin asks to change a customer's sign-in
 * email from the customer page (customers admin email change). Rule: `customers.customers.view`
 * and the protected `customers.customer-email.change` (Hassan R4), the admin population, not
 * acting as a seller; the route also needs a fresh step-up proof, which identity spends in the
 * unit of the request. The old address stays until the customer confirms the new one from that
 * mailbox with the password; a warning goes to the old one.
 */
export class AdminCustomerEmailChangeRequest extends UseCase<
  unknown,
  AdminEmailChangeRequested,
  AdminEmailChangeRequestFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-customer-email-change-request',
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
  ): Promise<Result<AdminEmailChangeRequested, AdminEmailChangeRequestFailure>> {
    return requestEmailChange(this.deps, context, input);
  }
}
