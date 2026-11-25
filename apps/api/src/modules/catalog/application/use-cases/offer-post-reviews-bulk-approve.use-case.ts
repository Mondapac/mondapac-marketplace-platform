import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PRODUCT_APPROVE } from '../../contracts/permissions';
import {
  parseBulkItems,
  runBulkDecide,
  type BulkDecideCounts,
  type BulkDecideFailure,
  type BulkDecideResult,
} from '../lists/bulk-decide';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { OfferPostReviewRepository } from '../ports/offer-post-review';
import type { OfferRepository } from '../ports/offer.repository';
import type { OwnCatalogReader } from '../ports/own-catalog.reader';
import type { AdminOfferPostReviewApprove } from './offer-post-review-approve.use-case';

export interface AdminOfferPostReviewsBulkApproveOutput {
  readonly counts: BulkDecideCounts;
  readonly results: readonly BulkDecideResult[];
}

export type AdminOfferPostReviewsBulkApproveFailure =
  { readonly code: 'access.denied' } | BulkDecideFailure;

export interface AdminOfferPostReviewsBulkApproveDependencies {
  readonly postReviewApprove: AdminOfferPostReviewApprove;
  readonly unitOfWork: UnitOfWork;
  readonly postReviews: OfferPostReviewRepository;
  readonly offers: OfferRepository;
  readonly ownReader: OwnCatalogReader;
  readonly policy: CatalogMarketPolicy;
}

/** Refusals of one row that mean "not decidable now" beyond the shared kit's: skipped, not failed. */
const SKIPPED = new Set(['post-review.own-submission']);

/**
 * `catalog.offer-post-reviews-bulk-approve` (risk-based Offer approval slice 6): an admin approves
 * up to 50 open rows of the post-publication list at once. Rule: `catalog.product.approve` and the
 * admin population. Body `{ items: [{ id, version }] }` (closed; 1 to 50, no id twice). Each row
 * runs the single approve use case in its own unit (its gate, version check and no-self-decision
 * rule), one after the other; a row that is not decidable now (`post-review.not-open`,
 * `post-review.not-found`, `conflict.stale`, `post-review.own-submission`) is `skipped` with its
 * code, an unexpected error `failed`. Results carry the product name (the Market's default locale)
 * for the result list. There is no bulk take-down.
 */
export class AdminOfferPostReviewsBulkApprove extends UseCase<
  { readonly items: unknown },
  AdminOfferPostReviewsBulkApproveOutput,
  AdminOfferPostReviewsBulkApproveFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.offer-post-reviews-bulk-approve',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_APPROVE.key] },
  };

  readonly #logger = new Logger('AdminOfferPostReviewsBulkApprove');

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminOfferPostReviewsBulkApproveDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly items: unknown },
  ): Promise<
    Result<AdminOfferPostReviewsBulkApproveOutput, AdminOfferPostReviewsBulkApproveFailure>
  > {
    const { actor } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const items = parseBulkItems(input?.items);
    if (!items.ok) return items;
    const done = await runBulkDecide(items.value, (item) =>
      this.deps.postReviewApprove.execute(context, { id: item.id, version: item.version }),
    );
    const names = await this.#names(
      context,
      items.value.map((item) => item.id),
    );
    const results = done.results.map((result): BulkDecideResult => {
      const skipped =
        result.outcome === 'failed' && result.reason !== undefined && SKIPPED.has(result.reason);
      return {
        ...result,
        ...(skipped ? { outcome: 'skipped' as const } : {}),
        name: names.get(result.id.toLowerCase()) ?? null,
      };
    });
    const counts: BulkDecideCounts = {
      done: results.filter((r) => r.outcome === 'done').length,
      skipped: results.filter((r) => r.outcome === 'skipped').length,
      failed: results.filter((r) => r.outcome === 'failed').length,
    };
    this.#logger.log({
      msg: 'catalog.offer-post-reviews-bulk-approve',
      done: counts.done,
      skipped: counts.skipped,
      failed: counts.failed,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return ok({ counts, results });
  }

  /** The product name of each row (best effort: a failed read leaves the names out). */
  async #names(context: CallContext, ids: readonly string[]): Promise<ReadonlyMap<string, string>> {
    const { market } = context;
    const { deps } = this;
    try {
      const locale = deps.policy.locales(market).default;
      const read = await deps.unitOfWork.run(
        market,
        async () => {
          const names = new Map<string, string>();
          const reviews = [];
          for (const id of ids) {
            const review = await deps.postReviews.findById(
              market,
              id.toLowerCase() as Id<'OfferPostReview'>,
            );
            if (review !== null) reviews.push(review);
          }
          const offers = await deps.offers.findManyByIds(
            market,
            reviews.map((review) => review.state.offerId),
          );
          const productOf = new Map(offers.map((offer) => [offer.state.id, offer.state.productId]));
          const productIds = [
            ...new Set(
              reviews.map(
                (review) => productOf.get(review.state.offerId) ?? review.state.productId,
              ),
            ),
          ];
          const labels =
            productIds.length === 0
              ? []
              : await deps.ownReader.productLabels(market, productIds, locale);
          const nameOf = new Map(labels.map((label) => [label.productId, label.name]));
          for (const review of reviews) {
            const name = nameOf.get(productOf.get(review.state.offerId) ?? review.state.productId);
            if (typeof name === 'string') names.set(review.state.id, name);
          }
          return ok(names);
        },
        { readOnly: true },
      );
      return read.ok ? read.value : new Map();
    } catch {
      return new Map();
    }
  }
}
