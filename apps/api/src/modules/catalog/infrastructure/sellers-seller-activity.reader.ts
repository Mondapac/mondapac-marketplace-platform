import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { SellersFacade } from '../../sellers';
import type {
  SellerActivityReader,
  SellerActivityUnavailable,
} from '../application/ports/seller-activity.reader';

/**
 * {@link SellerActivityReader} on `sellers.sellerBusinessActivities`. A refusal (another seller's
 * id, an admin request actor), a missing entry or a thrown error is `access.unavailable`: the
 * caller then allows no category (fail closed).
 */
export class SellersSellerActivityReader implements SellerActivityReader {
  constructor(private readonly sellers: SellersFacade) {}

  async activityIdsOf(
    context: CallContext,
    sellerId: Id<'Seller'>,
  ): Promise<Result<readonly Id<'BusinessActivity'>[], SellerActivityUnavailable>> {
    try {
      const answer = await this.sellers.sellerBusinessActivities(context, [sellerId]);
      if (!answer.ok) return err({ code: 'access.unavailable' });
      const held = answer.value.get(sellerId);
      if (held === undefined) return err({ code: 'access.unavailable' });
      return ok(held.activityIds);
    } catch {
      return err({ code: 'access.unavailable' });
    }
  }
}
