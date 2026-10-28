import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { SellersFacade } from '../../sellers';
import type { PickupDirectory } from '../application/ports/pickup-directory';

/**
 * The pickup from sellers' `carrierPickup` (audited per read): the address fields in the order of
 * the Market's seller `address.format`, the postcode field apart. A Market without a seller
 * address format, or an address without its postcode, has no pickup (the seller ships).
 */
export class SellersPickupDirectory implements PickupDirectory {
  constructor(
    private readonly sellers: SellersFacade,
    private readonly markets: MarketRegistry,
  ) {}

  async pickupOf(
    context: CallContext,
    request: { readonly sellerId: Id<'Seller'>; readonly sellerOrderId: Id<'SellerOrder'> },
  ) {
    const format = this.markets.get(context.market.marketId).sellers?.address;
    if (format === undefined) return err({ code: 'pickup.not-found' } as const);
    const read = await this.sellers.carrierPickup(context, request);
    if (!read.ok) {
      return err({
        code:
          read.error.code === 'seller.details-not-found'
            ? 'pickup.not-found'
            : 'pickup.unavailable',
      } as const);
    }
    const address = read.value.operatingAddress;
    const postcode = Object.hasOwn(address, format.postcodeField)
      ? address[format.postcodeField]
      : undefined;
    if (postcode === undefined || postcode === '')
      return err({ code: 'pickup.not-found' } as const);
    const addressLines = format.fields
      .filter((field) => field.key !== format.postcodeField)
      .map((field) => (Object.hasOwn(address, field.key) ? (address[field.key] ?? '') : ''))
      .filter((line) => line !== '');
    const field = (key: string | undefined): string | null =>
      key !== undefined && Object.hasOwn(address, key) ? (address[key] ?? '') || null : null;
    return ok({
      contactName: read.value.storeName,
      contactPhone: read.value.phone,
      addressLines,
      postcode,
      // From the seller's approved business file, never free text.
      locality: field(format.localityField) ?? '',
      region: field(format.regionField),
      location: null,
      notes: null,
    });
  }

  async postcodesOf(context: CallContext, sellerIds: readonly Id<'Seller'>[]) {
    const read = await this.sellers.pickupPostcodes(context, sellerIds);
    return read.ok ? ok(read.value) : err({ code: 'pickup.unavailable' } as const);
  }

  async zonesOf(context: CallContext, sellerIds: readonly Id<'Seller'>[]) {
    const read = await this.sellers.operatingZones(context, sellerIds);
    return read.ok ? ok(read.value) : err({ code: 'pickup.unavailable' } as const);
  }
}
