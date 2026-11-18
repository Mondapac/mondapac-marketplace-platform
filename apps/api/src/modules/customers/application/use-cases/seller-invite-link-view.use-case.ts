import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CUSTOMERS_SELLER_INVITE_LINK_MANAGE } from '../../contracts/permissions';
import {
  viewInviteLink,
  type InvitationDependencies,
  type InvitationFailure,
  type InviteLinkView,
} from '../seller-invitations-flow';

/**
 * `customers.seller-invite-link-view`: the shop's live invite link (its token; the panel builds the
 * link and the QR code) and how many customers joined through the shop's links (customers
 * management phase 4a). Rule: the seller key `customers.seller-invite-link.manage`, denied while
 * the shop is not approved; the shop is the session's; a Login as Seller session is refused.
 */
export class SellerInviteLinkView extends UseCase<
  Record<string, never>,
  InviteLinkView,
  InvitationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.seller-invite-link-view',
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
    return viewInviteLink(this.deps, context);
  }
}
