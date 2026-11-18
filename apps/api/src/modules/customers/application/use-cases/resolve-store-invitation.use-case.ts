import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  resolveInvitation,
  type InvitationDependencies,
  type InvitationFailure,
} from '../seller-invitations-flow';

/**
 * `customers.resolve-store-invitation`: the store an invite link leads to (its address only), for
 * the storefront's invite banner and sign-up line (phase 4a). Rule `anonymous`. Every token that
 * leads nowhere public now is one answer, `customers.invitation-not-found`.
 */
export class ResolveStoreInvitation extends UseCase<
  { readonly token?: unknown },
  { readonly slug: string },
  InvitationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.resolve-store-invitation',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: InvitationDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly token?: unknown },
  ): Promise<Result<{ readonly slug: string }, InvitationFailure>> {
    return resolveInvitation(this.deps, context, input);
  }
}
