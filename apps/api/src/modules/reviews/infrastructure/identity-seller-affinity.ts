import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { IdentityFacade } from '../../identity';
import type { SellerAffinity } from '../application/ports/seller-affinity';

/**
 * Whether the signed-in buyer is tied to the seller: identity answers true when the buyer's
 * sign-in address is also the address of an active member of that seller's team, so a person
 * with a customer account and a seller account on one address cannot review or rate their own
 * store. (A customer session is never a team member by account: identity keeps one population per
 * account for life, ADR-0018.) The account is the session's: an id that is not the caller's own
 * is refused. A failure to answer is thrown, so the request fails closed and never reads "not
 * tied".
 */
export class IdentitySellerAffinity implements SellerAffinity {
  constructor(private readonly identity: IdentityFacade) {}

  async isTiedToSeller(
    context: CallContext,
    accountId: Id<'Account'>,
    sellerId: Id<'Seller'>,
  ): Promise<boolean> {
    const actor = context.actor;
    if (actor.kind !== 'authenticated' || actor.accountId !== accountId) {
      throw new Error('reviews.seller-affinity: not the caller account');
    }
    const answer = await this.identity.ownAccountTiedToSeller(context, sellerId);
    if (!answer.ok) throw new Error(`reviews.seller-affinity: ${answer.error.code}`);
    return answer.value;
  }
}
