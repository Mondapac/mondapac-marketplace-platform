import type { Temporal } from '@mondapac/shared-kernel';
import type { ContentHash, Id } from '@mondapac/shared-kernel';
import type { SensitiveReason } from './product-revision-policy';
import type { RevisionContent } from './revision-content';

/** `submission`, `revert` or `tax-override` (data design 3.7; D 4.2 rows 1 and 6, D 4.3). */
export type RevisionKind = 'submission' | 'revert' | 'tax-override';

/**
 * A frozen revision as the store keeps it (data design 3.7 to 3.10): the record around the
 * content (who, when, how it was classified, the hash) and the content itself. Insert-only; the
 * published or pending status is derived from the product's pointers and the decision row.
 */
export interface StoredRevision {
  readonly id: Id<'ProductRevision'>;
  readonly productId: Id<'Product'>;
  /** Counts up from 1 per product. */
  readonly revisionNo: number;
  readonly kind: RevisionKind;
  /** The published revision it was built on; always set for a tax override. */
  readonly baseRevisionId: Id<'ProductRevision'> | null;
  readonly revertedFromRevisionId: Id<'ProductRevision'> | null;
  readonly sensitive: boolean;
  readonly sensitiveReasons: readonly SensitiveReason[];
  readonly contentHash: ContentHash;
  readonly authorKind: 'seller' | 'admin';
  readonly authorAccountId: Id<'Account'>;
  /** Acting-as (IMP-06): the admin behind a seller-authored revision. */
  readonly actingAdminAccountId: Id<'Account'> | null;
  readonly submittedAt: Temporal.Instant;
  readonly content: RevisionContent;
}
