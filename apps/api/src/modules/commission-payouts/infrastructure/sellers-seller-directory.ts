import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { SellersFacade } from '../../sellers';
import type { SellerDirectory } from '../application/ports/seller-directory';

/** {@link SellerDirectory} on the sellers facade: a seller exists when it has a file. */
export class SellersSellerDirectory implements SellerDirectory {
  constructor(private readonly sellers: SellersFacade) {}

  async exists(context: CallContext, sellerId: Id<'Seller'>): Promise<boolean | 'unavailable'> {
    const result = await this.sellers.sellerSummaries(context, [sellerId]);
    if (!result.ok) return 'unavailable';
    return result.value.some((summary) => summary.sellerId === sellerId && summary.exists);
  }
}
