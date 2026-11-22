import type { MarketContext } from '@mondapac/shared-kernel';
import type { CertificationTypeView } from '../../contracts/certification.facade';
import type { ClaimVocabularyEntry } from '../../domain/claim-text-matcher';

/**
 * Read-only view of the published type revisions of one Market (design 4.6, 8.1). Implemented
 * in infrastructure over `certification`'s own tables in one read-only unit; the Market comes
 * from the `MarketContext` only. A failure rejects: nothing here answers a guess.
 *
 * Acceptance criteria of the Prisma reader (Hassan, #142 and #161):
 * - `claimVocabulary` and `types` return exactly one entry per live type row of the Market, active
 *   or inactive. Explicit exception (new-type design 5, FE-091): a `proposed` new type and a
 *   `rejected` or `withdrawn` one are not read. Until a second admin approves it, a new type's
 *   terms block no text (one admin alone must not be able to block listings with a common word),
 *   and a closed proposal never had an effect; such a type has no seller certificate, issuer use
 *   or offer tag (every other read treats it as unknown). An approved type is live from the
 *   approval's commit. A type with a NULL or unresolvable published revision is a fault in both reads, and
 *   a type with no claim term is a fault in `claimVocabulary` only (`types` carries no terms); the
 *   caller answers `unavailable`, never drops the type: a dropped type lets its words pass unseen.
 *   Contract test: one type without a published revision, in both Market fixtures.
 * - A shuffled-order contract test for this reader and for `ClaimFactsReader`.
 */
export interface PublishedTypesReader {
  /** Per live type, active or inactive, the claim terms of every locale of its published revision. */
  claimVocabulary(market: MarketContext): Promise<readonly ClaimVocabularyEntry[]>;
  /** Types in code order, optionally filtered by status. */
  types(
    market: MarketContext,
    filter: { readonly status?: 'active' | 'inactive' },
  ): Promise<readonly CertificationTypeView[]>;
}
