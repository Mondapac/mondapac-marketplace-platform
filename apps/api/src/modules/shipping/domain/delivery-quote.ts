import { Temporal } from '@mondapac/shared-kernel';
import type { Id, Money } from '@mondapac/shared-kernel';
import type { CarrierMethod } from './booking-service';
import type { FleetCode } from './fleet';
import type { PricedDelivery } from './delivery-margin';
import type { SellerDeliveryAvailability } from './delivery-settings';

// The delivery quote a buyer is shown and charged (delivery models, package 5). A quote is the
// fleet the router chose, the fleet's price, the platform's margin on it and what the buyer pays.
// It holds for 10 minutes, and never past the fleet's own expiry; after that it is asked again.
// Pure rules over instants (the injected Clock); nothing here reads the system clock.

/** How long a quote holds, in minutes, when the fleet gives no earlier expiry. */
export const QUOTE_TTL_MINUTES = 10;

/** The methods a quote exists for; a pickup is free and has none. */
export type QuotedMethod = CarrierMethod;

export interface DeliveryQuote {
  readonly id: Id<'DeliveryQuote'>;
  /** The customer account the quote was made for: another account's quote is never charged. */
  readonly accountId: Id<'Account'>;
  readonly sellerId: Id<'Seller'>;
  readonly method: QuotedMethod;
  /** The postcode of the saved address the quote is for (never free text, SHP-02/03). */
  readonly dropoffPostcode: string;
  /** The fleet whose price this is. */
  readonly fleet: FleetCode;
  /** The fleet's price, the platform's margin, and `total` = `quote` + `margin`. */
  readonly quote: Money;
  readonly margin: Money;
  readonly total: Money;
  readonly etaMinutes: number | null;
  readonly quotedAt: Temporal.Instant;
  /** The fleet's own expiry, when it gave one. */
  readonly fleetExpiresAt: Temporal.Instant | null;
  /** When the quote stops being charged. */
  readonly validUntil: Temporal.Instant;
}

/**
 * When a quote asked at `quotedAt` stops holding: 10 minutes later, or the fleet's own expiry if
 * that is earlier. Null when the fleet's expiry is not after `quotedAt`: such a quote is already
 * stale and is never stored or shown.
 */
export function validUntilOf(
  quotedAt: Temporal.Instant,
  fleetExpiresAt: Temporal.Instant | null,
): Temporal.Instant | null {
  const ttl = quotedAt.add({ minutes: QUOTE_TTL_MINUTES });
  const until =
    fleetExpiresAt !== null && Temporal.Instant.compare(fleetExpiresAt, ttl) < 0
      ? fleetExpiresAt
      : ttl;
  return Temporal.Instant.compare(until, quotedAt) <= 0 ? null : until;
}

/** Whether the quote still holds at `now` (the instant it stops holding is already stale). */
export const isFresh = (quote: Pick<DeliveryQuote, 'validUntil'>, now: Temporal.Instant): boolean =>
  Temporal.Instant.compare(now, quote.validUntil) < 0;

/** What a request must match for a stored quote to answer it. */
export interface QuoteScope {
  readonly accountId: Id<'Account'>;
  readonly sellerId: Id<'Seller'>;
  readonly method: QuotedMethod;
  readonly dropoffPostcode: string;
}

export const matchesScope = (quote: DeliveryQuote, scope: QuoteScope): boolean =>
  quote.accountId === scope.accountId &&
  quote.sellerId === scope.sellerId &&
  quote.method === scope.method &&
  quote.dropoffPostcode === scope.dropoffPostcode;

/**
 * A new quote from the fleet's price, priced with the margin. Null when the fleet's expiry has
 * already passed (see {@link validUntilOf}).
 */
export function newDeliveryQuote(input: {
  readonly id: Id<'DeliveryQuote'>;
  readonly scope: QuoteScope;
  readonly fleet: FleetCode;
  readonly priced: PricedDelivery;
  readonly etaMinutes: number | null;
  readonly fleetExpiresAt: Temporal.Instant | null;
  readonly now: Temporal.Instant;
}): DeliveryQuote | null {
  const validUntil = validUntilOf(input.now, input.fleetExpiresAt);
  if (validUntil === null) return null;
  return Object.freeze({
    id: input.id,
    ...input.scope,
    fleet: input.fleet,
    quote: input.priced.quote,
    margin: input.priced.margin,
    total: input.priced.total,
    etaMinutes: input.etaMinutes,
    quotedAt: input.now,
    fleetExpiresAt: input.fleetExpiresAt,
    validUntil,
  });
}

/** Whether two quotes charge the buyer the same amount. */
export const sameTotal = (
  a: Pick<DeliveryQuote, 'total'>,
  b: Pick<DeliveryQuote, 'total'>,
): boolean => a.total.amount === b.total.amount && a.total.currency === b.total.currency;

/** A quote as the buyer's checkout sees it (the answer of the facade). */
export interface QuotedDelivery {
  readonly quoteId: Id<'DeliveryQuote'>;
  /** The fleet whose price it is. */
  readonly fleet: FleetCode;
  /** The fleet's price. */
  readonly quote: Money;
  /** What the platform adds (the margin and its rounding). */
  readonly margin: Money;
  /** What the buyer pays: `quote` + `margin`. */
  readonly total: Money;
  readonly etaMinutes: number | null;
  readonly quotedAt: Temporal.Instant;
  /** The instant the quote stops being charged. */
  readonly validUntil: Temporal.Instant;
}

export type MethodQuote =
  | { readonly kind: 'quoted'; readonly quote: QuotedDelivery }
  /** No fleet can carry the order the way the buyer wants it. */
  | { readonly kind: 'no-fleet' }
  /** The fleets that could carry it did not give a price now: ask again later. */
  | { readonly kind: 'failed' };

export interface SellerDeliveryQuotes {
  readonly availability: SellerDeliveryAvailability;
  /** The postcode where a pickup is collected, when the seller offers pickup. */
  readonly pickupPostcode: string | null;
  /** One entry for each delivering method that is open for the seller now. */
  readonly quotes: Readonly<Partial<Record<CarrierMethod, MethodQuote>>>;
}

/** The quote as checkout sees it. */
export const toQuotedDelivery = (quote: DeliveryQuote): QuotedDelivery => ({
  quoteId: quote.id,
  fleet: quote.fleet,
  quote: quote.quote,
  margin: quote.margin,
  total: quote.total,
  etaMinutes: quote.etaMinutes,
  quotedAt: quote.quotedAt,
  validUntil: quote.validUntil,
});
