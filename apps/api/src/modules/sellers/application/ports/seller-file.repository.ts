import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { SellerFile } from '../../domain/seller-file';

/**
 * The store of seller files (sellers data design 3.1, 3.7, 3.8, 3.9). Every method runs in the
 * open unit of the use case.
 */
export interface SellerFileRepository {
  /**
   * Inserts the file and, with it, the admin settings (from the defaults of the domain), the tax
   * profile and the store profile under the same id. Answers false and writes nothing when a file
   * of this id already exists in the Market, so a repeated or concurrent creation converges.
   */
  addWithRoots(market: MarketContext, file: SellerFile): Promise<boolean>;

  /** Which of the ids have a file in the Market. The caller bounds the list. */
  existingIds(
    market: MarketContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlySet<Id<'Seller'>>>;

  /**
   * The file of this seller in the Market with its draft (ciphertext as stored), or null: a
   * seller of another Market is null, exactly like an unknown id (AC 1). The seller id comes
   * from the actor, never from a request (AC 18).
   */
  findById(market: MarketContext, sellerId: Id<'Seller'>): Promise<SellerFile | null>;

  /**
   * Writes the draft columns, `draft_complete`, `last_changed_at` and the new version, only
   * where the stored version is still `file.persistedVersion` (optimistic, P 10). Answers false
   * and writes nothing when another unit changed the file first.
   */
  saveDraft(market: MarketContext, file: SellerFile): Promise<boolean>;
}

export const SELLER_FILE_REPOSITORY = Symbol('SELLER_FILE_REPOSITORY');
