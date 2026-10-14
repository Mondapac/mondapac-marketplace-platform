import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { AccessState } from '../../domain/seller-status';

/**
 * The access state `identity` holds for a seller (sellers design 3.3, 7.2; ADR-0022 decision 2),
 * read live and never copied. Called outside any unit of work (PP 3.1 row 5), with the caller's
 * `CallContext` unchanged. Null when `identity` does not know the seller in the Market (a seller
 * of another Market and an unknown id answer alike, AC 1). The adapter throws when `identity`
 * refuses or cannot answer, never a guessed state: a refusal of the actor is a
 * `SellerAccountAccessRefused` the caller answers `access.denied`, anything else
 * `sellers.unavailable` (`identityReadFailure`).
 */
export interface SellerAccessReader {
  accessOf(context: CallContext, sellerId: Id<'Seller'>): Promise<AccessState | null>;

  /**
   * Whether a rejected seller has used up its re-applications (slice 7b), asked of `identity`
   * with the Seller Owner's or Staff member's own `CallContext` only for a seller that
   * {@link accessOf} just reported `rejected`. Null when the Market configures no limit or
   * `identity` does not know the seller as the caller's own: never read as "reached". Throws as
   * {@link accessOf}.
   */
  reapplyLimitReachedOf(context: CallContext, sellerId: Id<'Seller'>): Promise<boolean | null>;

  /**
   * A rejected seller applies again (slice 7b), through `identity`'s `reapplySellerAccess` with
   * the Seller Owner's own context: `rejected` becomes `pending` and one re-application is
   * counted. `denied` when the caller is not the Seller Owner (identity allows only the owner), `wrong-state` when the seller is not rejected (it was moved meanwhile), `limit` when
   * the Market's re-apply limit is reached. Throws when `identity` refuses or cannot answer. Runs
   * in `identity`'s own unit, so it is called outside any unit of `sellers`.
   */
  reapply(
    context: CallContext,
    sellerId: Id<'Seller'>,
  ): Promise<'reapplied' | 'wrong-state' | 'limit' | 'denied'>;

  /**
   * The state of up to 100 sellers in one call (the admin list: one `identity` call per page).
   * A seller `identity` does not know is absent from the map. Throws when `identity` refuses or
   * cannot answer.
   */
  accessOfMany(
    context: CallContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, AccessState>>;
}

export const SELLER_ACCESS_READER = Symbol('SELLER_ACCESS_READER');
