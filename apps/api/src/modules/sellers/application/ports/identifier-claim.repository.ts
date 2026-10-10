import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { IdentifierIndexKey } from '../../domain/business-identifier';

/**
 * What taking a claim did (sellers design 3.6; data design 3.6): `taken` (inserted), `already-mine`
 * (this seller already holds this value, for this or an earlier revision), `held-by-other` (another
 * seller of the Market holds it: AC 21), `seller-holds-another` (nobody holds this value, but the
 * seller already holds a claim on another value: one claim per seller, Hassan on 7a-decide).
 */
export type ClaimOutcome = 'taken' | 'already-mine' | 'held-by-other' | 'seller-holds-another';

/**
 * The store of identifier claims: one approved or suspended seller per identifier value per
 * Market (AC 21). Every method runs in the open unit of the use case. A claim is never updated;
 * a refused insert leaves the unit usable.
 */
export interface IdentifierClaimRepository {
  take(
    market: MarketContext,
    claim: {
      readonly sellerId: Id<'Seller'>;
      readonly revisionId: Id<'BusinessFileRevision'>;
      readonly index: IdentifierIndexKey;
      readonly now: Temporal.Instant;
    },
  ): Promise<ClaimOutcome>;

  /**
   * Releases the claim this revision of this seller took (`identity` refused, design 3.6).
   * Answers whether a row went.
   */
  release(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    revisionId: Id<'BusinessFileRevision'>,
  ): Promise<boolean>;

  /** The seller that holds this value in the Market, or null. */
  holderOf(market: MarketContext, index: IdentifierIndexKey): Promise<Id<'Seller'> | null>;
}

export const IDENTIFIER_CLAIM_REPOSITORY = Symbol('IDENTIFIER_CLAIM_REPOSITORY');
