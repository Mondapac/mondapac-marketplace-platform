import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import type { BusinessFileRevision } from '../../domain/business-file-revision';
import type { SealedRevisionContent } from '../../domain/sealed';
import type { SealedRevision } from './revision-content-sealer';

/**
 * Why an insert did nothing: the file already has a pending revision (data design 3.2, the
 * partial unique key), the revision number is taken (the writer read a stale latest number), or
 * the id exists. Nothing is written in any of these cases, and the unit stays usable.
 */
export type RevisionAddRefused =
  | { readonly code: 'revision.pending-exists' }
  | { readonly code: 'revision.number-taken' }
  | { readonly code: 'revision.id-taken' };

/**
 * The store of business file revisions (sellers data design 3.2; slice 5a). Every method runs in
 * the open unit of the use case and takes the `MarketContext`; every statement names the Market.
 * The reads return the revision without its content: the sealed content is read on its own, by
 * the one use case that needs it, so ciphertext never travels with a list or a status check.
 *
 * Slice 5b adds the withdrawal and the read of the approved zones. Not here yet: supersede and
 * decide, and the move of the approved pointer (slice 7a-decide).
 */
/** The two clear zone columns of an approved revision (data design 3.2). */
export interface ApprovedZones {
  readonly operatingTimezone: string;
  /** Null for a revision backfilled without an address (data design 3.2). */
  readonly addressTimezone: string | null;
}

export interface BusinessFileRevisionRepository {
  /**
   * Inserts a new `pending` revision with its sealed content. The revision's content hash must be
   * the sealed content's hash. Answers a refusal and writes nothing when the one-pending key, the
   * revision-number key or the id is taken, so two concurrent submissions converge on one.
   */
  add(
    market: MarketContext,
    revision: BusinessFileRevision,
    sealed: SealedRevision,
  ): Promise<Result<void, RevisionAddRefused>>;

  /** The seller's revision with the highest number, whatever its status, or null. */
  findLatest(market: MarketContext, sellerId: Id<'Seller'>): Promise<BusinessFileRevision | null>;

  /** The seller's pending revision, or null. At most one exists (the database holds it). */
  findPending(market: MarketContext, sellerId: Id<'Seller'>): Promise<BusinessFileRevision | null>;

  /**
   * The live approved revision, found through the file's pointer (`approved_revision_id`), or
   * null when the pointer is empty. The pointer is the authority (data design 3.1).
   */
  findApproved(market: MarketContext, sellerId: Id<'Seller'>): Promise<BusinessFileRevision | null>;

  /** One revision of this seller by id; a revision of another seller or Market is null. */
  findById(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    id: Id<'BusinessFileRevision'>,
  ): Promise<BusinessFileRevision | null>;

  /**
   * Writes the withdrawal of a pending revision (`withdrawn` from the domain): one `UPDATE …
   * WHERE status = 'pending'` on the five columns a withdrawal sets, with the row count checked.
   * Answers false and writes nothing when the revision is no longer pending (a decision, another
   * withdrawal), so a lost race is the caller's `conflict.stale`. The revision must be
   * `withdrawn` and carry its withdrawal.
   */
  saveWithdrawal(market: MarketContext, revision: BusinessFileRevision): Promise<boolean>;

  /**
   * The approved zones of up to 100 sellers of the Market (sellers design 7.1a row 7; data design
   * A18): the approved pointer on `seller_files`, then the revision it names; the clear zone
   * columns only, no key. A seller with no approved revision, of another Market, or unknown is not
   * in the answer. The caller bounds the list.
   */
  approvedZones(
    market: MarketContext,
    sellerIds: readonly Id<'Seller'>[],
  ): Promise<ReadonlyMap<Id<'Seller'>, ApprovedZones>>;

  /** The sealed content of one revision of this seller, as stored; null when there is none. */
  readSealedContent(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    id: Id<'BusinessFileRevision'>,
  ): Promise<SealedRevisionContent | null>;
}

export const BUSINESS_FILE_REVISION_REPOSITORY = Symbol('BUSINESS_FILE_REVISION_REPOSITORY');
