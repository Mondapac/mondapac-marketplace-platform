import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { ManualRegisterCheck } from '../../domain/review-check';

/**
 * The store of review checks (sellers data design 3.3; slice 7a-decide records the manual register
 * check only). Every method runs in the open unit of the use case and names the Market and the
 * seller, so a check never reaches another seller's revision.
 */
export interface ReviewCheckRepository {
  /** The manual register check recorded on this revision of this seller, or null. */
  findManualRegisterCheck(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    revisionId: Id<'BusinessFileRevision'>,
  ): Promise<ManualRegisterCheck | null>;

  /**
   * Records the manual register check of a revision (an upsert on the key: recording it again
   * replaces what the reviewer read). The caller has checked that the revision is pending and no
   * decision is in flight, under the file's lock.
   */
  recordManualRegisterCheck(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    check: ManualRegisterCheck,
  ): Promise<void>;
}

export const REVIEW_CHECK_REPOSITORY = Symbol('REVIEW_CHECK_REPOSITORY');
