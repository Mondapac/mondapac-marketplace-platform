import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { SellersFacade } from '../../sellers';
import type { SellerPayoutAccess, SellerZone } from '../application/ports/payout-gateways';

/**
 * {@link SellerPayoutAccess} on the sellers facade. The zone is the seller's own operating zone
 * and never the Market's: for the system actor `sellerSummaries` gives the draft's zone marked
 * `provisional` (never paid on), for a seller's request `operatingZones` gives the approved
 * revision's zone only. A seller with no zone is absent. Eligibility is `sellingEligibility`: a
 * missing key, an error or anything but a clear yes is "not eligible".
 */
export class SellersSellerPayoutAccess implements SellerPayoutAccess {
  constructor(private readonly sellers: SellersFacade) {}

  async zones(context: CallContext, sellerIds: readonly Id<'Seller'>[]) {
    const zones = new Map<Id<'Seller'>, SellerZone>();
    if (context.actor.kind === 'system') {
      const result = await this.sellers.sellerSummaries(context, sellerIds);
      if (!result.ok) return 'unavailable' as const;
      for (const summary of result.value) {
        if (summary.operatingTimezone !== undefined) {
          zones.set(summary.sellerId, {
            zone: summary.operatingTimezone.zone,
            provisional: summary.operatingTimezone.provisional,
          });
        }
      }
      return zones;
    }
    const result = await this.sellers.operatingZones(context, sellerIds);
    if (!result.ok) return 'unavailable' as const;
    for (const [sellerId, zone] of result.value) zones.set(sellerId, { zone, provisional: false });
    return zones;
  }

  async eligible(context: CallContext, sellerIds: readonly Id<'Seller'>[]) {
    const result = await this.sellers.sellingEligibility(context, sellerIds);
    if (!result.ok) return 'unavailable' as const;
    return new Map(
      sellerIds.map((sellerId): [Id<'Seller'>, boolean] => [
        sellerId,
        result.value.get(sellerId)?.eligible === true,
      ]),
    );
  }
}
