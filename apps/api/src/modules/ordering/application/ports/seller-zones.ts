import type { CallContext, Id } from '@mondapac/shared-kernel';

/**
 * The IANA zone a seller works in (ADR-0005: the owning party's zone), for the seller tasks' local
 * day. The seller's approved operating zone (sellers' `operatingZones`), or the Market's zone when
 * the seller has no approved file yet (the documented fallback). A failed read throws: the count
 * then answers `access.unavailable` rather than guessing a day.
 */
export interface SellerZones {
  zoneOf(context: CallContext, sellerId: Id<'Seller'>): Promise<string>;
}

export const SELLER_ZONES = Symbol('ORDERING_SELLER_ZONES');
