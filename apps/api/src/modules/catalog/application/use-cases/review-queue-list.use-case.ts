import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PRODUCT_VIEW } from '../../contracts/permissions';
import type { OfferHandling } from '../../domain/offer';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { OfferRepository } from '../ports/offer.repository';
import type { OwnCatalogReader } from '../ports/own-catalog.reader';
import type { VariantGtinRegistry } from '../ports/variant-gtin.registry';
import type { SellerNamesReader } from '../ports/seller-names.reader';
import { requiredChecksOf } from '../revisions/review-checks';
import { invalid, parsePage, isoOf, type ValidationFailure } from '../own-reads/own-reads.shared';

export interface ReviewQueueListInput {
  readonly afterId?: unknown;
  readonly limit?: unknown;
  /** `product-revision` or `offer-first-publication`: one kind of row only. */
  readonly kind?: unknown;
  /** One seller's rows only. */
  readonly sellerId?: unknown;
  /** Product revisions only: a first publication (true) or an update (false). */
  readonly firstPublication?: unknown;
  /** Product revisions only: the pending revision has a photo (true) or none (false). */
  readonly hasImages?: unknown;
}

/** The two kinds of row in the queue. */
export const REVIEW_QUEUE_KINDS = ['product-revision', 'offer-first-publication'] as const;
export type ReviewQueueKind = (typeof REVIEW_QUEUE_KINDS)[number];

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
  /**
   * Warnings for the reviewer (V4): `gtin.duplicate-platform` when a GTIN of the revision is already
   * carried by a published PLATFORM product (the seller can sell on it), `gtin.duplicate` when it is
   * carried by any other product. Advice only; it never blocks a decision.
   */
  readonly warnings: readonly string[];
  readonly submittedAt: string;
}

export type ReviewQueueRow = OfferReviewRow | ProductRevisionReviewRow;

export interface ReviewQueueListOutput {
  readonly items: readonly ReviewQueueRow[];
  /** The `afterId` of the next page; null on the last page. */
  readonly nextAfterId: string | null;
  /** The rows the filters keep, over every page. With no filter, the whole queue. */
  readonly total: number;
  /** Every row of each kind in the Market's queue, whatever the filters (the tab counts). */
  readonly totals: Readonly<Record<ReviewQueueKind, number>>;
}

export type ReviewQueueListFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' } | ValidationFailure;

export interface ReviewQueueListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly offers: OfferRepository;
  readonly ownReader: OwnCatalogReader;
  readonly policy: CatalogMarketPolicy;
  readonly sellerNames: SellerNamesReader;
  readonly gtinRegistry: VariantGtinRegistry;
}

interface Position {
  readonly submittedAt: Temporal.Instant;
  readonly id: string;
}

const CURSOR = /^(\d{1,15})_([0-9a-f-]{36})$/;

interface QueueFilter {
  readonly kind: ReviewQueueKind | null;
  readonly sellerId?: Id<'Seller'>;
  readonly firstPublication?: boolean;
  readonly hasImages?: boolean;
}

const FILTER_KEYS = ['kind', 'sellerId', 'firstPublication', 'hasImages'] as const;

/**
 * The filters of the queue. `firstPublication` and `hasImages` are product revision fields: given,
 * they keep revisions only, and asking them of Offers is refused.
 */
function parseFilter(record: Record<string, unknown>): Result<QueueFilter, ValidationFailure> {
  const kind = record['kind'];
  if (
    kind !== undefined &&
    (typeof kind !== 'string' || !(REVIEW_QUEUE_KINDS as readonly string[]).includes(kind))
  ) {
    return invalid('kind', 'unknown');
  }
  let sellerId: Id<'Seller'> | undefined;
  if (record['sellerId'] !== undefined) {
    const parsed =
      typeof record['sellerId'] === 'string' ? parseId<'Seller'>(record['sellerId']) : null;
    if (parsed === null || !parsed.ok) return invalid('sellerId', 'format');
    sellerId = parsed.value;
  }
  const flags: { firstPublication?: boolean; hasImages?: boolean } = {};
  for (const key of ['firstPublication', 'hasImages'] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') return invalid(key, 'type');
    if (kind === 'offer-first-publication') return invalid(key, 'not-allowed');
    flags[key] = value;
  }
  return ok({
    kind: (kind as ReviewQueueKind | undefined) ?? null,
    ...(sellerId === undefined ? {} : { sellerId }),
    ...flags,
  });
}

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
 * previous page; the filters (`kind`, `sellerId`, and for revisions `firstPublication` and
 * `hasImages`) keep the same order, so a cursor stays valid under the same filters. `total` counts
 * what the filters keep, `totals` the whole queue per kind. One read-only unit (ADR-0025); the store-name call follows it.
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
    const record: Record<string, unknown> =
      typeof input === 'object' && input !== null && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
    // The shared page parser checks the size and the keys; the cursor and filters are this queue's.
    const pageInput: unknown =
      typeof input === 'object' && input !== null && !Array.isArray(input)
        ? Object.fromEntries(
            Object.entries(record).filter(
              ([key]) => key !== 'afterId' && !(FILTER_KEYS as readonly string[]).includes(key),
            ),
          )
        : input;
    const page = parsePage<'Offer'>(pageInput);
    if (!page.ok) return page;
    const filter = parseFilter(record);
    if (!filter.ok) return filter;
    const { limit } = page.value;
    const after = cursor.value;
    const { kind, sellerId, firstPublication, hasImages } = filter.value;
    const revisionOnly = firstPublication !== undefined || hasImages !== undefined;
    const withOffers = kind !== 'product-revision' && !revisionOnly;
    const withRevisions = kind !== 'offer-first-publication';
    const offerFilter = sellerId === undefined ? {} : { sellerId };
    const revisionFilter = {
      ...offerFilter,
      ...(firstPublication === undefined ? {} : { firstPublication }),
      ...(hasImages === undefined ? {} : { hasImages }),
    };
    let locale: string;
    try {
      locale = this.deps.policy.locales(market).default;
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        const offers = withOffers
          ? await this.deps.offers.listPendingReview(
              market,
              { after, limit: limit + 1 },
              offerFilter,
            )
          : [];
        const revisions = withRevisions
          ? await this.deps.ownReader.listPendingRevisions(
              market,
              { after, limit: limit + 1 },
              locale,
              revisionFilter,
            )
          : [];
        const labels = await this.deps.ownReader.productLabels(
          market,
          [...new Set(offers.slice(0, limit).map((offer) => offer.state.productId))],
          locale,
        );
        const warnings = new Map<string, readonly string[]>();
        for (const row of revisions.slice(0, limit)) {
          const found =
            row.variantGtins.length === 0
              ? []
              : await this.deps.gtinRegistry.duplicatesOf(market, row.productId, [
                  ...new Set(row.variantGtins),
                ]);
          warnings.set(
            row.revisionId,
            found.length === 0
              ? []
              : [
                  found.some((d) => d.scope === 'PLATFORM')
                    ? 'gtin.duplicate-platform'
                    : 'gtin.duplicate',
                ],
          );
        }
        const totals = {
          'product-revision': await this.deps.ownReader.pendingRevisionCount(market),
          'offer-first-publication': await this.deps.ownReader.pendingReviewCount(market),
        };
        const filtered = sellerId !== undefined || revisionOnly;
        const total =
          (withOffers
            ? filtered
              ? await this.deps.ownReader.pendingReviewCount(market, offerFilter)
              : totals['offer-first-publication']
            : 0) +
          (withRevisions
            ? filtered
              ? await this.deps.ownReader.pendingRevisionCount(market, revisionFilter)
              : totals['product-revision']
            : 0);
        return ok({ offers, revisions, labels, total, totals, warnings });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    const { offers, revisions, labels, total, totals, warnings } = read.value;
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
          warnings: warnings.get(row.revisionId) ?? [],
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
      totals,
    });
  }
}
