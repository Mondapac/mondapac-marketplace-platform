import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import type { Product, ProductRefusal } from '../../domain/product';
import type { StoredRevision } from '../../domain/stored-revision';
import type { ProductRepository } from '../ports/product.repository';
import type { ProductRevisionRepository } from '../ports/product-revision.repository';
import { requiredChecksOf, type ReviewCheckCode } from './review-checks';

export interface ReviewValidationFailure {
  readonly code: 'validation.failed';
  readonly fields: readonly { readonly path: string; readonly code: string }[];
}

/** The refusals the aggregate can give a review command, passed through with their code. */
export type ProductReviewRefusal = Extract<
  ProductRefusal,
  {
    code:
      | 'review.not-current-revision'
      | 'revision.base-changed'
      | 'product.not-editable'
      | 'variant.unknown'
      | 'variant.none'
      | 'variant.limit-reached';
  }
>;

export type PendingRevisionLoadFailure =
  | { readonly code: 'product.not-found' }
  | { readonly code: 'review.not-current-revision' }
  | { readonly code: 'conflict.stale' };

const fail = (path: string, code: string): { ok: false; error: ReviewValidationFailure } =>
  err({ code: 'validation.failed', fields: [{ path, code }] }) as {
    ok: false;
    error: ReviewValidationFailure;
  };

/**
 * A reviewer's decision on a product revision: a closed body naming the product, the revision the
 * reviewer saw and the product version they saw (a decision on a stale page is `conflict.stale`),
 * plus the keys the caller allows.
 */
export function parseProductDecision(
  input: unknown,
  extraKeys: readonly string[],
): Result<
  {
    productId: Id<'Product'>;
    revisionId: Id<'ProductRevision'>;
    version: number;
    raw: Record<string, unknown>;
  },
  ReviewValidationFailure
> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return fail('body', 'type');
  }
  const raw = input as Record<string, unknown>;
  const allowed = ['productId', 'revisionId', 'version', ...extraKeys];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) return fail(key, 'unknown');
  }
  const product =
    typeof raw['productId'] === 'string' ? parseId<'Product'>(raw['productId']) : null;
  if (product === null || !product.ok) return fail('productId', 'format');
  const revision =
    typeof raw['revisionId'] === 'string' ? parseId<'ProductRevision'>(raw['revisionId']) : null;
  if (revision === null || !revision.ok) return fail('revisionId', 'format');
  const version = raw['version'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return fail('version', 'type');
  }
  return ok({ productId: product.value, revisionId: revision.value, version, raw });
}

export interface PendingRevisionForReview {
  readonly product: Product;
  readonly revision: StoredRevision;
  readonly ownerSellerId: Id<'Seller'>;
  readonly requiredChecks: readonly ReviewCheckCode[];
}

/**
 * Loads the SELLER product, the pending revision the reviewer named and the checks the server
 * derives for it, inside the caller's open unit. A missing product, a PLATFORM product and a
 * product without an owner are `product.not-found`; a version other than the reviewer's is
 * `conflict.stale`; a revision other than the pending one is `review.not-current-revision`.
 */
export async function loadPendingForReview(
  deps: { readonly products: ProductRepository; readonly revisions: ProductRevisionRepository },
  market: MarketContext,
  ids: {
    readonly productId: Id<'Product'>;
    readonly revisionId: Id<'ProductRevision'>;
    readonly version: number;
  },
): Promise<Result<PendingRevisionForReview, PendingRevisionLoadFailure>> {
  const product = await deps.products.findById(market, ids.productId);
  const { state } = product ?? {};
  if (
    product === null ||
    state === undefined ||
    state.scope !== 'SELLER' ||
    state.ownerSellerId === null
  ) {
    return err({ code: 'product.not-found' });
  }
  if (state.version !== ids.version) return err({ code: 'conflict.stale' });
  if (state.pendingRevisionId === null || state.pendingRevisionId !== ids.revisionId) {
    return err({ code: 'review.not-current-revision' });
  }
  const revision = await deps.revisions.find(market, state.id, ids.revisionId);
  if (revision === null) return err({ code: 'conflict.stale' });
  return ok({
    product,
    revision,
    ownerSellerId: state.ownerSellerId,
    requiredChecks: requiredChecksOf({
      firstPublication: state.publishedRevisionId === null,
      reasons: revision.sensitiveReasons,
    }),
  });
}
