import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { IdentityFacade } from '../../identity';
import type { SellerOwnerContact } from '../application/ports/decision-mail.ports';

/**
 * {@link SellerOwnerContact} on `identity.contactEmailOf` (request R-4, accepted): the Seller
 * Owner's sign-in address for the `system` caller. A refusal throws, so the delivery is retried;
 * the address is returned to one send and never logged.
 */
export class IdentitySellerOwnerContact implements SellerOwnerContact {
  constructor(private readonly identity: IdentityFacade) {}

  async emailOf(context: CallContext, sellerId: Id<'Seller'>): Promise<string | null> {
    const found = await this.identity.contactEmailOf(context, { kind: 'seller-owner', sellerId });
    if (!found.ok) throw new Error('decision-mail: the address could not be read');
    return found.value;
  }
}
