import type { Id, MarketContext, Result, Temporal } from '@mondapac/shared-kernel';
import type { NoteKeyDestroyed } from './admin-order-notes';

/** A seller's note as stored: its text is sealed under the order's customer account subject key. */
export interface StoredSellerNote {
  readonly id: Id<'SellerOrderNote'>;
  readonly orderId: Id<'Order'>;
  readonly sellerOrderId: Id<'SellerOrder'>;
  readonly sellerId: Id<'Seller'>;
  readonly authorAccountId: Id<'Account'>;
  readonly bodySealed: string;
  readonly createdAt: Temporal.Instant;
}

/** The seller's own paid seller order a note is written on, and the customer whose key seals it. */
export interface NotedSellerOrder {
  readonly orderId: Id<'Order'>;
  readonly accountId: Id<'Account'>;
}

/**
 * The sellers' own notes on their seller orders (`ordering.seller_order_notes`), through the
 * Market-scoped client in the open unit of the use case. Every method names the seller: another
 * shop's seller order answers exactly as an unknown one. Insert only: a note is never changed or
 * removed.
 */
export interface SellerOrderNoteRepository {
  /** The seller's own paid seller order, or null (unknown, unpaid, another shop's or Market's). */
  sellerOrderOf(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    sellerOrderId: Id<'SellerOrder'>,
  ): Promise<NotedSellerOrder | null>;
  insert(market: MarketContext, note: StoredSellerNote): Promise<void>;
  /** The seller order's notes written by this seller, newest first, at most `limit`. */
  list(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    sellerOrderId: Id<'SellerOrder'>,
    limit: number,
  ): Promise<readonly StoredSellerNote[]>;
}

export const SELLER_ORDER_NOTE_REPOSITORY = Symbol('SELLER_ORDER_NOTE_REPOSITORY');

/**
 * Seals and opens a seller note's text under the customer account's subject key (ordering data
 * design O8), with a label of its own: an admin note's sealed text never opens as a seller note's.
 * Plaintext never reaches a log, an event, an audit row or an error.
 */
export interface SellerNoteCipher {
  seal(
    market: MarketContext,
    accountId: Id<'Account'>,
    body: string,
  ): Promise<Result<string, NoteKeyDestroyed>>;
  open(
    market: MarketContext,
    accountId: Id<'Account'>,
    sealed: string,
  ): Promise<Result<string, NoteKeyDestroyed>>;
}

export const SELLER_NOTE_CIPHER = Symbol('SELLER_NOTE_CIPHER');
