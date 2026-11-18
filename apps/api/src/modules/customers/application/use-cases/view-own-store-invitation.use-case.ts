import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  viewOwnInvitation,
  type InvitationDependencies,
  type InvitationFailure,
  type OwnInvitationView,
} from '../seller-invitations-flow';

/**
 * `customers.view-own-store-invitation`: the store the signed-in customer joined through, for the
 * account's privacy line (phase 4a). Rule `own-resources`; a Login-as session is refused.
 */
export class ViewOwnStoreInvitation extends UseCase<
  Record<string, never>,
  OwnInvitationView,
  InvitationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.view-own-store-invitation',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: InvitationDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext): Promise<Result<OwnInvitationView, InvitationFailure>> {
    return viewOwnInvitation(this.deps, context);
  }
}
