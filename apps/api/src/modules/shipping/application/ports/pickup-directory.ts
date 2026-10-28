import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { CarrierStop } from './carrier-gateway';

/**
 * Where the carrier collects a seller's parcel: the store name, phone and operating address of
 * the seller's approved business file (sellers' `carrierPickup`, audited per read). PERSONAL DATA:
 * handed to the carrier only.
 */
export interface PickupDirectory {
  pickupOf(
    context: CallContext,
    request: { readonly sellerId: Id<'Seller'>; readonly sellerOrderId: Id<'SellerOrder'> },
  ): Promise<Result<CarrierStop, { readonly code: 'pickup.not-found' | 'pickup.unavailable' }>>;

  /**
   * The pickup postcode of each seller, for a quote (sellers' `pickupPostcodes`, a clear column
   * with no audit). A seller without one is absent from the map.
   */
  postcodesOf(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<Result<ReadonlyMap<Id<'Seller'>, string>, { readonly code: 'pickup.unavailable' }>>;

  /**
   * The operating zone (IANA id) of each seller's approved file (sellers' `operatingZones`), for
   * a cut-off and a delivery window. A seller without one is absent: the Market zone applies.
   */
  zonesOf(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<Result<ReadonlyMap<Id<'Seller'>, string>, { readonly code: 'pickup.unavailable' }>>;
}

export const PICKUP_DIRECTORY = Symbol('PICKUP_DIRECTORY');
