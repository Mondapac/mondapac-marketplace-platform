import type { Id, MarketContext, Result, Temporal } from '@mondapac/shared-kernel';

/** A note as stored: its text is sealed under the order's customer account subject key. */
export interface StoredAdminNote {
  readonly id: Id<'AdminOrderNote'>;
  readonly orderId: Id<'Order'>;
  readonly authorAccountId: Id<'Account'>;
  readonly bodySealed: string;
  readonly createdAt: Temporal.Instant;
}

/**
 * The admins' internal notes on orders (`ordering.admin_order_notes`), through the Market-scoped
 * client in the open unit of the use case. Insert only: a note is never changed or removed.
 */
export interface AdminOrderNoteRepository {
  /** The customer account of the order, or null for an unknown or another Market's order. */
  orderAccount(market: MarketContext, orderId: Id<'Order'>): Promise<Id<'Account'> | null>;
  insert(market: MarketContext, note: StoredAdminNote): Promise<void>;
  /** The order's notes, newest first, at most `limit`. */
  list(
    market: MarketContext,
    orderId: Id<'Order'>,
    limit: number,
  ): Promise<readonly StoredAdminNote[]>;
}

export const ADMIN_ORDER_NOTE_REPOSITORY = Symbol('ADMIN_ORDER_NOTE_REPOSITORY');

/** The customer's key was destroyed (the account was erased): the notes about them are gone. */
export type NoteKeyDestroyed = { readonly code: 'subject-key.destroyed' };

/**
 * Seals and opens a note's text under the customer account's subject key (ordering data design
 * O8). Plaintext never reaches a log, an event, an audit row or an error.
 */
export interface AdminNoteCipher {
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

export const ADMIN_NOTE_CIPHER = Symbol('ADMIN_NOTE_CIPHER');
