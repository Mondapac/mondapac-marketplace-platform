import type { Id, MarketContext, Result, Temporal } from '@mondapac/shared-kernel';
import type { StoredCustomerNote } from '../../domain/customer-note';

/**
 * The admins' notes about customers (`customers.customer_notes`), in the open unit. Insert and
 * read only: a note is never changed; the account's erasure deletes them.
 */
export interface CustomerNoteRepository {
  insert(market: MarketContext, note: StoredCustomerNote): Promise<void>;
  /** The customer's notes, newest first, after the cursor (keyset on created, id). */
  page(
    market: MarketContext,
    accountId: Id<'Account'>,
    after: { readonly createdAt: Temporal.Instant; readonly id: string } | null,
    limit: number,
  ): Promise<readonly StoredCustomerNote[]>;
  count(market: MarketContext, accountId: Id<'Account'>): Promise<number>;
}

export const CUSTOMER_NOTE_REPOSITORY = Symbol('CUSTOMER_NOTE_REPOSITORY');

/** The customer's key was destroyed (the account was erased). */
export type NoteKeyDestroyed = { readonly code: 'subject-key.destroyed' };

/** Seals and opens a note under the customer account's subject key. Plaintext never leaves. */
export interface CustomerNoteCipher {
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

export const CUSTOMER_NOTE_CIPHER = Symbol('CUSTOMER_NOTE_CIPHER');
