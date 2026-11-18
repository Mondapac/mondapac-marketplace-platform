import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  joinStoreByInvitation,
  type InvitationDependencies,
  type InvitationFailure,
  type JoinedStore,
} from '../seller-invitations-flow';

/**
 * `customers.join-store-by-invitation`: the signed-in customer claims the invite link they signed
 * up through (phase 4a): new sign-ups only, one store for good; the store is followed for them.
 * Rule `own-resources`: the account is the session's, never an input; a Login-as session is refused.
 */
export class JoinStoreByInvitation extends UseCase<unknown, JoinedStore, InvitationFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.join-store-by-invitation',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: InvitationDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<JoinedStore, InvitationFailure>> {
    return joinStoreByInvitation(this.deps, context, input as { readonly token?: unknown });
  }
}
