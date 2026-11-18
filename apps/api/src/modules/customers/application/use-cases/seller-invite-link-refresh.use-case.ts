import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_SELLER_INVITE_LINK_MANAGE } from '../../contracts/permissions';
import {
  refreshInviteLink,
  type InvitationDependencies,
  type InvitationFailure,
  type InviteLinkView,
} from '../seller-invitations-flow';

/**
 * `customers.seller-invite-link-refresh`: draws a new invite link for the shop and revokes the live
 * one (its QR codes stop working; the customers who joined through it stay the shop's). Audited.
 * Rule: the seller key `customers.seller-invite-link.manage`, denied while the shop is not
 * approved; the shop is the session's; a Login as Seller session is refused.
 */
export class SellerInviteLinkRefresh extends UseCase<
  Record<string, never>,
  InviteLinkView,
  InvitationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.seller-invite-link-refresh',
    rule: { kind: 'permissions', allOf: [CUSTOMERS_SELLER_INVITE_LINK_MANAGE.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: InvitationDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext): Promise<Result<InviteLinkView, InvitationFailure>> {
    return refreshInviteLink(this.deps, context);
  }
}
