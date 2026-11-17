import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type {
  SellerCustomerEntry,
  SellerCustomerRecord,
  SellerCustomerSelector,
  SellerCustomerSort,
  SellerCustomerTab,
} from '../../domain/seller-customers';

/** A list query of one seller's customers: what to match and the instant "now" is. */
export interface SellerCustomerQuery {
  readonly sellerId: Id<'Seller'>;
  readonly selector: SellerCustomerSelector;
}

/** New buyers (first order) and new followers (follow started) in one month of the seller's zone. */
export interface MonthlyCount {
  /** `YYYY-MM` in the zone the caller gave. */
  readonly month: string;
  readonly newBuyers: number;
  readonly newFollowers: number;
}

/**
 * `customers.seller_customers` (customers management phase 3). Every method runs in the open
 * unit of the use case and puts the Market, and the seller where it reads a list, in the
 * statement: one seller's rows are never read for another.
 */
export interface SellerCustomerRepository {
  /** The codes of the account's rows, by seller (the sync keeps a code once drawn). */
  codesOfAccount(
    market: MarketContext,
    accountId: Id<'Account'>,
  ): Promise<ReadonlyMap<Id<'Seller'>, string>>;

  /** Whether the seller already gave this code to a customer. */
  codeTaken(market: MarketContext, sellerId: Id<'Seller'>, code: string): Promise<boolean>;

  /** Inserts the row with `code`, or replaces its numbers and flags and keeps its code. */
  upsert(
    market: MarketContext,
    entry: SellerCustomerEntry,
    code: string,
    now: Temporal.Instant,
  ): Promise<void>;

  /** Removes the account's rows of these sellers (no relation left). */
  removeSellers(
    market: MarketContext,
    accountId: Id<'Account'>,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<void>;

  /** One page of the seller's customers in `sort` order (the account id as tie-break). */
  page(
    market: MarketContext,
    query: SellerCustomerQuery,
    order: { readonly sort: SellerCustomerSort; readonly direction: 'asc' | 'desc' },
    window: { readonly offset: number; readonly limit: number },
  ): Promise<readonly SellerCustomerRecord[]>;

  count(market: MarketContext, query: SellerCustomerQuery): Promise<number>;

  /** The rows of each tab of the seller's list. */
  tabCounts(
    market: MarketContext,
    sellerId: Id<'Seller'>,
  ): Promise<Readonly<Record<SellerCustomerTab, number>>>;

  /** One of the seller's customers by its code; null for a code the seller never gave. */
  findByCode(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    code: string,
  ): Promise<SellerCustomerRecord | null>;

  /**
   * The seller's rows of these accounts (accounts the seller has no row for are dropped). For
   * the seller's own order pages, which know the account and show the code and first name.
   */
  findByAccounts(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    accountIds: readonly Id<'Account'>[],
  ): Promise<readonly SellerCustomerRecord[]>;

  /** The seller's rows of these codes (others dropped), in the order given. */
  findByCodes(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    codes: readonly string[],
  ): Promise<readonly SellerCustomerRecord[]>;

  /** New buyers and new followers of the seller per month, between the instants given. */
  monthly(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    months: readonly {
      readonly month: string;
      readonly from: Temporal.Instant;
      readonly to: Temporal.Instant;
    }[],
  ): Promise<readonly MonthlyCount[]>;
}

export const SELLER_CUSTOMER_REPOSITORY = Symbol('CUSTOMERS_SELLER_CUSTOMER_REPOSITORY');

/** Draws a new customer code (`XXXX-XXXX`). */
export interface CustomerCodes {
  next(): string;
}

export const CUSTOMER_CODES = Symbol('CUSTOMERS_CUSTOMER_CODES');

/** The IANA zone a seller's monthly trend is cut in: the Market's zone (ADR-0005 fallback). */
export interface TrendZones {
  zoneOf(market: MarketContext): string;
}

export const TREND_ZONES = Symbol('CUSTOMERS_TREND_ZONES');
