import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMER_SESSION_END } from '../../contracts/permissions';
import {
  signOutCustomerEverywhere,
  type CustomerSecurityDependencies,
  type CustomerSecurityFailure,
} from '../accounts/customer-security';

/**
 * `identity.admin-sign-out-customer`: "sign out everywhere" on the customer page (customers
 * management phase 2b): every session of the customer account ends (reason `admin-signed-out`),
 * in one unit under the account's credential lock, with the audit row. Rule `permissions
 * [identity.customer-session.end]`, a platform admin not acting as anyone. No step-up: disabling
 * the account, which also ends every session, asks none either. Facade only.
 */
export class AdminSignOutCustomer extends UseCase<
  { readonly accountId: Id<'Account'> },
  { readonly revokedSessions: number },
  CustomerSecurityFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.admin-sign-out-customer',
    rule: { kind: 'permissions', allOf: [CUSTOMER_SESSION_END.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CustomerSecurityDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly accountId: Id<'Account'> },
  ): Promise<Result<{ readonly revokedSessions: number }, CustomerSecurityFailure>> {
    return signOutCustomerEverywhere(this.deps, context, input.accountId);
  }
}
