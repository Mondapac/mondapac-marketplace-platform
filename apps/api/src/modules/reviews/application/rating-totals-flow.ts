import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { MAX_RATING_TOTALS_PAGE, type ProductRatingTotalsPage } from '../contracts/reviews.facade';
import { activeSettings } from './market-switch';
import type { SummaryFailure } from './failures';
import type { ReviewsDependencies } from './reviews-dependencies';

export interface ProductRatingTotalsInput {
  readonly after?: unknown;
  readonly limit?: unknown;
}

/**
 * The stored star totals of the products with published reviews, a page at a time (rule `system`).
 * Read from the rebuilt summary rows in one read-only unit; `reviews.disabled` while reviews are
 * off. One more row than asked is read to know whether another page follows.
 */
export async function productRatingTotals(
  deps: ReviewsDependencies,
  context: CallContext,
  input: ProductRatingTotalsInput,
): Promise<Result<ProductRatingTotalsPage, SummaryFailure>> {
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  const fields: { path: string; code: string }[] = [];
  let after: Id<'Product'> | null = null;
  if (input?.after !== undefined && input.after !== null) {
    const parsed = typeof input.after === 'string' ? parseId<'Product'>(input.after) : null;
    if (parsed === null || !parsed.ok) fields.push({ path: 'after', code: 'format' });
    else after = parsed.value;
  }
  let limit = MAX_RATING_TOTALS_PAGE;
  if (input?.limit !== undefined) {
    if (
      typeof input.limit === 'number' &&
      Number.isInteger(input.limit) &&
      input.limit >= 1 &&
      input.limit <= MAX_RATING_TOTALS_PAGE
    ) {
      limit = input.limit;
    } else {
      fields.push({ path: 'limit', code: 'range' });
    }
  }
  if (fields.length > 0) return err({ code: 'validation.failed', fields });

  const read = await deps.unitOfWork.run(
    context.market,
    async () => ok(await deps.reviews.listProductRatingTotals(context.market, after, limit + 1)),
    { readOnly: true },
  );
  if (!read.ok) return err({ code: 'reviews.unavailable' });
  const items = read.value.slice(0, limit);
  const last = items[items.length - 1];
  return ok({
    items,
    next: read.value.length > limit && last !== undefined ? last.productId : null,
  });
}
