import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { SellersFacade } from '../../sellers';
import type {
  AllowedProductTypes,
  AllowedProductTypesReader,
} from '../application/ports/allowed-product-types.reader';

/**
 * {@link AllowedProductTypesReader} on `sellers.allowedProductTypesOf` (catalog design 9.4,
 * SEL-12). Any refusal or thrown error is `null`, which every caller refuses (fail closed,
 * ADR-0031); an error is never read as "allowed".
 */
export class SellersAllowedProductTypesReader implements AllowedProductTypesReader {
  constructor(private readonly sellers: SellersFacade) {}

  async allowedFor(
    context: CallContext,
    sellerId: Id<'Seller'>,
  ): Promise<AllowedProductTypes | null> {
    try {
      const answer = await this.sellers.allowedProductTypesOf(context, sellerId);
      return answer.ok ? answer.value : null;
    } catch {
      return null;
    }
  }
}
