import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMER_PASSWORD_RESET_SEND } from '../../contracts/permissions';
import {
  sendCustomerPasswordReset,
  type CustomerPasswordResetDependencies,
  type AdminPasswordResetFailure,
} from '../accounts/customer-security';

/**
 * `identity.admin-send-customer-password-reset`: "send password reset" on the customer page
 * (customers management phase 2b). The reset link of "Forgot password?" is requested for the
 * customer and the mail goes to their own verified address; the admin sees no token. Rule
 * `permissions [identity.customer-password-reset.send]`, a platform admin not acting as anyone.
 * Audited. No step-up: the mail reaches only the account holder. Facade only.
 */
export class AdminSendCustomerPasswordReset extends UseCase<
  { readonly accountId: Id<'Account'> },
  { readonly sent: true },
  AdminPasswordResetFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.admin-send-customer-password-reset',
    rule: { kind: 'permissions', allOf: [CUSTOMER_PASSWORD_RESET_SEND.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CustomerPasswordResetDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly accountId: Id<'Account'> },
  ): Promise<Result<{ readonly sent: true }, AdminPasswordResetFailure>> {
    return sendCustomerPasswordReset(this.deps, context, input.accountId);
  }
}
