import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { SellerZoneAnswer, SellerZonesSource } from '../application/ports/claim-facts.ports';
import type { ApprovedSellerZonesReader } from '../../sellers/contracts/approved-seller-zones.contract';

/**
 * {@link SellerZonesSource} over the `sellers` approved-zones contract (request S-1). The
 * caller's context goes through unchanged; a refusal rejects, so `evaluateClaims` answers
 * `unavailable` (fail closed). A missing zone stays `null`, never a default.
 */
export class SellersZonesSource implements SellerZonesSource {
  constructor(private readonly reader: ApprovedSellerZonesReader) {}

  async zonesOf(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<SellerZoneAnswer> {
    const result = await this.reader.approvedSellerZones(context, sellerIds);
    if (!result.ok) throw new Error(`approved seller zones refused: ${result.error.code}`);
    return result.value;
  }
}
