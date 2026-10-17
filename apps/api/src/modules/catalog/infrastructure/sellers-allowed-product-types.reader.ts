import type { CallContext, Id } from '@mondapac/shared-kernel';
import { PermissiveInterim } from '../../../platform/placeholders/placeholder-markers';
import type { SellersFacade } from '../../sellers';
import type {
  AllowedProductTypes,
  AllowedProductTypesReader,
} from '../application/ports/allowed-product-types.reader';

/**
 * {@link AllowedProductTypesReader} on `sellers.allowedProductTypesOf` (catalog design 9.4,
 * SEL-12). Any refusal or thrown error is `null`, which every caller refuses (fail closed,
 * ADR-0031); an error is never read as "allowed".
 *
 * ADR-0031 decision 4a: until sellers slice 14 the facade answers `all` for every seller, more
 * permissive than SEL-12's final rule, so this binding counts in the bound set and refuses a
 * production start (catalog design 15.1). Remove the marker in the slice 14 binding PR.
 */
@PermissiveInterim('sellers.allowedProductTypesOf')
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
