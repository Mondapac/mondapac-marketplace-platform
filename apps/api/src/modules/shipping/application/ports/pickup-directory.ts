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
}

export const PICKUP_DIRECTORY = Symbol('PICKUP_DIRECTORY');
