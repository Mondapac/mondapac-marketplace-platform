/**
 * How a seller handles the goods of an Offer (catalog design 2.1; CERT-44): a claim input of
 * every certification query, so both the Offer and its tags read it from here.
 */
export const OFFER_HANDLINGS = ['SEALED_ORIGINAL', 'REPACKED', 'PREPARED', 'FRESH'] as const;
export type OfferHandling = (typeof OFFER_HANDLINGS)[number];

/** The audit codes of the handlings: audit enums are lower-case codes (PA 3.2). */
export const OFFER_HANDLING_AUDIT_CODES = [
  'sealed-original',
  'repacked',
  'prepared',
  'fresh',
] as const;
export type OfferHandlingAuditCode = (typeof OFFER_HANDLING_AUDIT_CODES)[number];

/** The audit code of a handling, or null for none. */
export function handlingAuditCode(handling: OfferHandling | null): OfferHandlingAuditCode | null {
  return handling === null ? null : OFFER_HANDLING_AUDIT_CODES[OFFER_HANDLINGS.indexOf(handling)]!;
}
