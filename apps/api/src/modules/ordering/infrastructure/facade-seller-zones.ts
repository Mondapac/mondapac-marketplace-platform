import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { SellersFacade } from '../../sellers';
import type { MarketZones } from '../application/ports/ship-to-retention.repository';
import type { SellerZones } from '../application/ports/seller-zones';

/** Thrown when sellers cannot answer; the message names no seller. */
export class SellerZoneUnavailableError extends Error {
  constructor() {
    super('The seller zone could not be read');
  }
}

/**
 * {@link SellerZones} through sellers' `operatingZones` (rule `anonymous`, a clear column), with
 * the caller's context unchanged; the Market's zone when the seller is absent from the answer.
 */
export class FacadeSellerZones implements SellerZones {
  constructor(
    private readonly sellers: Pick<SellersFacade, 'operatingZones'>,
    private readonly markets: MarketZones,
  ) {}

  async zoneOf(context: CallContext, sellerId: Id<'Seller'>): Promise<string> {
    const answer = await this.sellers.operatingZones(context, [sellerId]);
    if (!answer.ok) throw new SellerZoneUnavailableError();
    return answer.value.get(sellerId) ?? this.markets.zoneOf(context.market);
  }
}
