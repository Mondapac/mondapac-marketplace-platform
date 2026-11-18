import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMER_SIGN_IN_VIEW } from '../../contracts/permissions';
import {
  readCustomerSessions,
  type CustomerSecurityDependencies,
  type CustomerSecurityFailure,
  type CustomerSessionsView,
} from '../accounts/customer-security';

/**
 * `identity.admin-customer-sessions`: a customer's live sessions (device, signed in, last active;
 * no id, token or address), at most 50 (customers management phase 2b). Rule `permissions
 * [identity.customer-sign-in.view]`, a platform admin not acting as anyone. Facade only.
 */
export class AdminCustomerSessions extends UseCase<
  { readonly accountId: Id<'Account'> },
  CustomerSessionsView,
  CustomerSecurityFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.admin-customer-sessions',
    rule: { kind: 'permissions', allOf: [CUSTOMER_SIGN_IN_VIEW.key] },
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
  ): Promise<Result<CustomerSessionsView, CustomerSecurityFailure>> {
    return readCustomerSessions(this.deps, context, input.accountId);
  }
}
