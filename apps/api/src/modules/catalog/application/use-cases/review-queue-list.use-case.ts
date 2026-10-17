import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PRODUCT_VIEW } from '../../contracts/permissions';
import type { OfferHandling } from '../../domain/offer';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { OfferRepository } from '../ports/offer.repository';
import type { OwnCatalogReader } from '../ports/own-catalog.reader';
import type { SellerNamesReader } from '../ports/seller-names.reader';
import { requiredChecksOf } from '../revisions/review-checks';
import { invalid, parsePage, isoOf, type ValidationFailure } from '../own-reads/own-reads.shared';

export interface ReviewQueueListInput {
  readonly afterId?: unknown;
  readonly limit?: unknown;
}

/** One Offer waiting for its first publication (catalog design 9.2 `review-queue.list`). */
export interface OfferReviewRow {
  readonly kind: 'offer-first-publication';
  readonly offerId: string;
  /** The version a decision must name. */
  readonly version: number;
  readonly sellerId: string;
  /** The seller's public store name; null when `sellers` cannot say. */
  readonly storeName: string | null;
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

/** One seller product whose pending revision waits for a decision (design 8.2, 9.2 item 8). */
export interface ProductRevisionReviewRow {
  readonly kind: 'product-revision';
  readonly productId: string;
  /** The pending revision a decision must name. */
  readonly revisionId: string;
  readonly revisionNo: number;
  /** The product version a decision must name. */
  readonly version: number;
  readonly sellerId: string;
  readonly storeName: string | null;
  readonly product: {
    readonly productCode: string;
    readonly typeCode: string;
    /** The pending revision's name, default locale. */
    readonly name: string | null;
  };
  readonly firstPublication: boolean;
  /** What changed, as classification codes (design 4.3). */
  readonly reasons: readonly string[];
  /** The named checks an approval must confirm (design 8.3a), derived by the server. */
  readonly requiredChecks: readonly string[];
  readonly hasImages: boolean;
  readonly submittedAt: string;
}

export type ReviewQueueRow = OfferReviewRow | ProductRevisionReviewRow;

export interface ReviewQueueListOutput {
  readonly items: readonly ReviewQueueRow[];
  /** The `afterId` of the next page; null on the last page. */
  readonly nextAfterId: string | null;
  /** Every Offer and every pending product revision of the Market in the queue. */
  readonly total: number;
}

export type ReviewQueueListFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' } | ValidationFailure;

export interface ReviewQueueListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly offers: OfferRepository;
  readonly ownReader: OwnCatalogReader;
  readonly policy: CatalogMarketPolicy;
  readonly sellerNames: SellerNamesReader;
}

interface Position {
  readonly submittedAt: Temporal.Instant;
  readonly id: string;
}

const CURSOR = /^(\d{1,15})_([0-9a-f-]{36})$/;

/** The cursor of a page: the submit instant (ms) and id of its last row. */
const cursorOf = (position: Position): string =>
  `${position.submittedAt.epochMilliseconds}_${position.id}`;

function parseCursor(value: unknown): Result<Position | null, ValidationFailure> {
  if (value === undefined || value === null) return ok(null);
  const match = typeof value === 'string' ? CURSOR.exec(value) : null;
  const id = match?.[2] === undefined ? null : parseId(match[2]);
  if (match === null || id === null || !id.ok) return invalid('afterId', 'format');
  return ok({
    submittedAt: Temporal.Instant.fromEpochMilliseconds(Number(match[1])),
    id: id.value,
  });
}

/**
 * `review-queue.list` (catalog design 8.2, 9.2): what waits for a reviewer, oldest submit first
 * (then by id), keyset-paged: Offers waiting for their first publication and seller products with
 * a pending revision, in one list. Each row carries its `kind`, the seller's public store name
 * (`sellerSummaries`; absent when `sellers` cannot say) and the label of its product; a product
 * revision row also carries what changed and the checks an approval must confirm. Rule: the key
 * `catalog.product.view` and the admin population. `afterId` is the opaque `nextAfterId` of the
 * previous page. One read-only unit (ADR-0025); the store-name call follows it.
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
    const cursor =
      typeof input === 'object' && input !== null ? parseCursor(input.afterId) : ok(null);
    if (!cursor.ok) return cursor;
    // The shared page parser checks the size and the keys; the cursor is this queue's own.
    const page = parsePage<'Offer'>(
      typeof input === 'object' && input !== null && !Array.isArray(input)
        ? { ...input, afterId: undefined }
        : input,
    );
    if (!page.ok) return page;
    const { limit } = page.value;
    const after = cursor.value;
    let locale: string;
    try {
      locale = this.deps.policy.locales(market).default;
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        const offers = await this.deps.offers.listPendingReview(market, {
          after,
          limit: limit + 1,
        });
        const revisions = await this.deps.ownReader.listPendingRevisions(
          market,
          { after, limit: limit + 1 },
          locale,
        );
        const labels = await this.deps.ownReader.productLabels(
          market,
          [...new Set(offers.slice(0, limit).map((offer) => offer.state.productId))],
          locale,
        );
        const total =
          (await this.deps.ownReader.pendingReviewCount(market)) +
          (await this.deps.ownReader.pendingRevisionCount(market));
        return ok({ offers, revisions, labels, total });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    const { offers, revisions, labels, total } = read.value;
    const labelOf = new Map(labels.map((label) => [label.productId, label]));

    // Merge the two sources into one order: submit instant, then id.
    const merged = [
      ...offers.map((offer) => ({
        kind: 'offer' as const,
        at: offer.state.submittedAt?.epochMilliseconds ?? 0,
        position: {
          submittedAt: offer.state.submittedAt ?? Temporal.Instant.fromEpochMilliseconds(0),
          id: offer.state.id,
        },
        offer,
      })),
      ...revisions.map((row) => ({
        kind: 'revision' as const,
        at: row.submittedAt.epochMilliseconds,
        position: { submittedAt: row.submittedAt, id: row.productId },
        row,
      })),
    ].sort((a, b) => a.at - b.at || (a.position.id < b.position.id ? -1 : 1));
    const shown = merged.slice(0, limit);
    const last = shown[shown.length - 1];

    const names = await this.deps.sellerNames.storeNames(context, [
      ...new Set(
        shown.map((entry) =>
          entry.kind === 'offer' ? entry.offer.state.sellerId : entry.row.sellerId,
        ),
      ),
    ] as Id<'Seller'>[]);

    const items = shown.map((entry): ReviewQueueRow => {
      if (entry.kind === 'revision') {
        const { row } = entry;
        return {
          kind: 'product-revision',
          productId: row.productId,
          revisionId: row.revisionId,
          revisionNo: row.revisionNo,
          version: row.productVersion,
          sellerId: row.sellerId,
          storeName: names.get(row.sellerId) ?? null,
          product: { productCode: row.productCode, typeCode: row.typeCode, name: row.name },
          firstPublication: row.firstPublication,
          reasons: row.sensitiveReasons,
          requiredChecks: requiredChecksOf({
            firstPublication: row.firstPublication,
            reasons: row.sensitiveReasons,
          }),
          hasImages: row.hasImages,
          submittedAt: row.submittedAt.toString(),
        };
      }
      const { state } = entry.offer;
      const label = labelOf.get(state.productId);
      return {
        kind: 'offer-first-publication',
        offerId: state.id,
        version: state.version,
        sellerId: state.sellerId,
        storeName: names.get(state.sellerId) ?? null,
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
    });
    return ok({
      items,
      nextAfterId:
        merged.length > shown.length && last !== undefined ? cursorOf(last.position) : null,
      total,
    });
  }
}
