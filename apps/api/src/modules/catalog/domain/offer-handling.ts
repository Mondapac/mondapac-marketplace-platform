/**
 * How a seller handles the goods of an Offer (catalog design 2.1; CERT-44): a claim input of
 * every certification query, so both the Offer and its tags read it from here.
 */
export const OFFER_HANDLINGS = ['SEALED_ORIGINAL', 'REPACKED', 'PREPARED', 'FRESH'] as const;
export type OfferHandling = (typeof OFFER_HANDLINGS)[number];
