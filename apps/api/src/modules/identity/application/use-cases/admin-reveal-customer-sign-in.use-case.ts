import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMER_SIGN_IN_REVEAL, CUSTOMER_SIGN_IN_VIEW } from '../../contracts/permissions';
import {
  revealCustomerSignInAddress,
  type CustomerSecurityDependencies,
  type CustomerSecurityFailure,
} from '../accounts/customer-security';

/**
 * `identity.admin-reveal-customer-sign-in`: the full client address of one of a customer's sign-ins
 * of the last 90 days (customers management phase 2b). Rule `permissions
 * [identity.customer-sign-in.view, identity.customer-sign-in.reveal]` (the second protected), a
 * platform admin not acting as anyone. Audited in the unit that read it, before it is answered;
 * `customers` adds the timeline entry. Facade only.
 */
export class AdminRevealCustomerSignIn extends UseCase<
  { readonly accountId: Id<'Account'>; readonly signInId: Id<'SignInRecord'> },
  { readonly address: string; readonly occurredAt: string },
  CustomerSecurityFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.admin-reveal-customer-sign-in',
    rule: { kind: 'permissions', allOf: [CUSTOMER_SIGN_IN_VIEW.key, CUSTOMER_SIGN_IN_REVEAL.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CustomerSecurityDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly accountId: Id<'Account'>; readonly signInId: Id<'SignInRecord'> },
  ): Promise<
    Result<{ readonly address: string; readonly occurredAt: string }, CustomerSecurityFailure>
  > {
    return revealCustomerSignInAddress(this.deps, context, input);
  }
}
