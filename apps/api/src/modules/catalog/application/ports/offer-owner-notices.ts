import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';

// Where catalog's notice to an Offer owner goes (certification request C-6; certification slice
// 15): the Seller Owner's sign-in address through `identity`'s contact point, the Market's mail
// sender and the Market's zone the dates are named in. Until `notifications` (Phase 6) mail is
// the only channel.

/**
 * The Seller Owner's address for the `system` caller. Personal data: used for one send and never
 * logged, stored or put in an event. `null` when there is none to use (unknown, disabled, not
 * verified, all alike). A refusal or a fault throws, so the delivery is retried.
 */
export interface OfferOwnerContact {
  emailOf(context: CallContext, sellerId: Id<'Seller'>): Promise<string | null>;
}

export const OFFER_OWNER_CONTACT = Symbol('CATALOG_OFFER_OWNER_CONTACT');

/** The Market's settings of a notice mail, from its configuration. */
export interface OfferOwnerMailSettings {
  /** The Market's mail sender (the one identity's mail uses). */
  sender(market: MarketContext): { readonly address: string; readonly name: string };
  /** The Market's configured zone (IANA id), in which a manufacturer certificate's day counts. */
  zone(market: MarketContext): string;
}

export const OFFER_OWNER_MAIL_SETTINGS = Symbol('CATALOG_OFFER_OWNER_MAIL_SETTINGS');
