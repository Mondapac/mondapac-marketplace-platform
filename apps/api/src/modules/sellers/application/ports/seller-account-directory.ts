import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { AccessState } from '../../domain/seller-status';

/**
 * One seller as `identity`'s admin read answers it (identity design 8.1 `sellerAccountSummaries`;
 * design 7.8; slice 6b): the access state and the Seller Owner. The owner's name and address are
 * PERSONAL DATA for the admin who asked: never logged, cached, or put in an event, an audit row,
 * an outbox or an error body; rendered as escaped text only.
 */
export interface SellerAccountEntry {
  readonly state: AccessState;
  /** Null while the seller has no owner (an owner invitation not accepted yet). */
  readonly owner: { readonly displayName: string | null; readonly email: string } | null;
}

/** The Market's registered sellers per access state (R-6 counts). */
export type SellerStateCounts = Readonly<Record<AccessState, number>>;

/**
 * The admin reads of `identity` the seller list needs (design 7.8; R-6 and 8.1; slice 6b), with
 * the admin's `CallContext` unchanged, outside any unit of work. Both need
 * `identity.seller-access.view` and throw when `identity` refuses or cannot answer: the caller
 * answers `sellers.unavailable`, never a guess.
 */
export interface SellerAccountDirectory {
  /** State and owner of up to 100 sellers; a seller `identity` does not know is absent. */
  accountsOf(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, SellerAccountEntry>>;

  /**
   * Up to `limit` (0 to 100) ids of registered sellers in `state`, newest first, below `before`,
   * and the counts per state; `state` null with `limit` 0 for the counts only.
   */
  idsByState(
    context: CallContext,
    query: {
      readonly state: AccessState | null;
      readonly before: Id<'Seller'> | null;
      readonly limit: number;
    },
  ): Promise<{
    readonly sellerIds: readonly Id<'Seller'>[];
    readonly next: Id<'Seller'> | null;
    readonly counts: SellerStateCounts;
  }>;
}

export const SELLER_ACCOUNT_DIRECTORY = Symbol('SELLER_ACCOUNT_DIRECTORY');
