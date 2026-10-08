import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { SellerAccessContract } from '../../identity/contracts/seller-access.contract';
import type {
  RegisteredSellerPage,
  RegisteredSellerSource,
} from '../application/ports/registered-seller-source';

/**
 * {@link RegisteredSellerSource} on `identity`'s seller-access contract (sellers design R-6,
 * 14.3 Q-M4): the registered sellers of the Market by id, with their origin, for the system
 * actor. Ids and origins only; no state, no instant, no name. A refusal throws, so the backfill
 * ends and the next run tries again.
 */
export class IdentityRegisteredSellers implements RegisteredSellerSource {
  constructor(private readonly identity: SellerAccessContract) {}

  async page(
    context: CallContext,
    after: Id<'Seller'> | null,
    limit: number,
  ): Promise<RegisteredSellerPage> {
    const result = await this.identity.listRegisteredSellers(context, { after, limit });
    if (!result.ok) {
      throw new Error(`identity.listRegisteredSellers refused: ${result.error.code}`);
    }
    return result.value;
  }
}
