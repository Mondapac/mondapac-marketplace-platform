import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { DeliveryQuote, QuoteScope } from '../../domain/delivery-quote';

/**
 * The delivery quotes of one Market (`shipping.delivery_quotes`). Every method runs inside the
 * caller's unit of work and is scoped by the Market.
 */
export interface DeliveryQuoteRepository {
  insert(market: MarketContext, quote: DeliveryQuote): Promise<void>;

  /** A quote by id, whoever it was made for (the caller checks the scope). */
  findById(market: MarketContext, id: Id<'DeliveryQuote'>): Promise<DeliveryQuote | null>;

  /** The newest quote of the scope that still holds at `now`, or null. */
  findFresh(
    market: MarketContext,
    scope: QuoteScope,
    now: Temporal.Instant,
  ): Promise<DeliveryQuote | null>;

  /** Removes the account's quotes that stopped holding before `before` (bounded, per account). */
  deleteExpired(
    market: MarketContext,
    accountId: Id<'Account'>,
    before: Temporal.Instant,
  ): Promise<void>;
}

export const DELIVERY_QUOTE_REPOSITORY = Symbol('DELIVERY_QUOTE_REPOSITORY');
