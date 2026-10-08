import type { MarketContext } from '@mondapac/shared-kernel';
import type { CertificationTypeView } from '../../contracts/certification.facade';
import type { ClaimVocabularyEntry } from '../../domain/claim-text-matcher';

/**
 * Read-only view of the published type revisions of one Market (design 4.6, 8.1). Implemented
 * in infrastructure over `certification`'s own tables in one read-only unit; the Market comes
 * from the `MarketContext` only. A failure rejects: nothing here answers a guess.
 *
 * Acceptance criteria of the Prisma reader (Hassan, #142 and #161):
 * - `claimVocabulary` and `types` return exactly one entry per type row of the Market, active or
 *   inactive. A type with a NULL or unresolvable published revision, or with no terms, is a fault
 *   (the caller answers `unavailable`), never dropped: a dropped type lets its words pass unseen.
 *   Contract test: one type without a published revision, in both Market fixtures.
 * - A shuffled-order contract test for this reader and for `ClaimFactsReader`.
 */
export interface PublishedTypesReader {
  /** Per type, active or inactive, the claim terms of every locale of its published revision. */
  claimVocabulary(market: MarketContext): Promise<readonly ClaimVocabularyEntry[]>;
  /** Types in code order, optionally filtered by status. */
  types(
    market: MarketContext,
    filter: { readonly status?: 'active' | 'inactive' },
  ): Promise<readonly CertificationTypeView[]>;
}
