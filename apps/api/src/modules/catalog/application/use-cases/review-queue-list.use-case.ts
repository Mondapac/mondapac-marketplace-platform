import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PRODUCT_VIEW } from '../../contracts/permissions';
import type { OfferHandling } from '../../domain/offer';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { OfferRepository } from '../ports/offer.repository';
import type { OwnCatalogReader } from '../ports/own-catalog.reader';
import { parsePage, isoOf, type ValidationFailure } from '../own-reads/own-reads.shared';

export interface ReviewQueueListInput {
  readonly afterId?: unknown;
  readonly limit?: unknown;
}

/** One Offer waiting for its first publication (catalog design 9.2 `review-queue.list`). */
export interface ReviewQueueRow {
  readonly kind: 'offer-first-publication';
  readonly offerId: string;
  /** The version a decision must name. */
  readonly version: number;
  readonly sellerId: string;
  readonly productId: string;
  readonly product: {
    readonly productCode: string | null;
    readonly typeCode: string | null;
    readonly name: string | null;
  };
  readonly sellerSku: string;
  readonly conditionCode: string;
  readonly description: Readonly<Record<string, string>>;
  readonly handling: OfferHandling | null;
  /** The instant the seller submitted; the queue is oldest first. */
  readonly submittedAt: string | null;
}

export interface ReviewQueueListOutput {
  readonly items: readonly ReviewQueueRow[];
  /** The `afterId` of the next page; null on the last page. */
  readonly nextAfterId: string | null;
}

export type ReviewQueueListFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' } | ValidationFailure;

export interface ReviewQueueListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly offers: OfferRepository;
  readonly ownReader: OwnCatalogReader;
  readonly policy: CatalogMarketPolicy;
}

/**
 * `review-queue.list` (catalog design 8.2, 9.2): the Offers that wait for their first publication,
 * oldest submit first, keyset-paged, each with the label of its product. Rule: the key
 * `catalog.product.view` and the admin population. One read-only unit (ADR-0025). Product revisions
 * join this queue with slice 10; seller store names join with `sellerSummaries`.
 */
export class ReviewQueueList extends UseCase<
  ReviewQueueListInput,
  ReviewQueueListOutput,
  ReviewQueueListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.review-queue-list',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReviewQueueListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ReviewQueueListInput,
  ): Promise<Result<ReviewQueueListOutput, ReviewQueueListFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const page = parsePage<'Offer'>(input);
    if (!page.ok) return page;
    let locale: string;
    try {
      locale = this.deps.policy.locales(market).default;
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        const rows = await this.deps.offers.listPendingReview(market, {
          afterId: page.value.afterId,
          limit: page.value.limit + 1,
        });
        const shown = rows.slice(0, page.value.limit);
        const labels = await this.deps.ownReader.productLabels(
          market,
          [...new Set(shown.map((offer) => offer.state.productId))],
          locale,
        );
        return ok({ rows, shown, labels });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    const { rows, shown, labels } = read.value;
    const labelOf = new Map(labels.map((label) => [label.productId, label]));
    return ok({
      items: shown.map((offer) => {
        const { state } = offer;
        const label = labelOf.get(state.productId);
        return {
          kind: 'offer-first-publication' as const,
          offerId: state.id,
          version: state.version,
          sellerId: state.sellerId,
          productId: state.productId,
          product: {
            productCode: label?.productCode ?? null,
            typeCode: label?.typeCode ?? null,
            name: label?.name ?? null,
          },
          sellerSku: state.sellerSku,
          conditionCode: state.conditionCode,
          description: state.description,
          handling: state.handling,
          submittedAt: isoOf(state.submittedAt),
        };
      }),
      nextAfterId: rows.length > shown.length ? (shown[shown.length - 1]?.state.id ?? null) : null,
    });
  }
}
