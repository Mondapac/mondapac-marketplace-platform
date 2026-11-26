import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, MarketId } from '@mondapac/shared-kernel';
import type { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import { instantRangeOn } from '../../../platform/list-query';
import type {
  OfferPostReviewFilter,
  OfferPostReviewPage,
  OfferPostReviewReasonReceipt,
  OfferPostReviewRepository,
} from '../application/ports/offer-post-review';
import type { OfferChangeReason } from '../domain/events';
import {
  OfferPostReview,
  type OfferPostReviewReason,
  type OfferPostReviewStatus,
} from '../domain/offer-post-review';
import { offerQueueSearchWhere } from './review-queue-search';

type Row = Prisma.CatalogOfferPostReviewGetPayload<object>;

/** The partial unique of the open row (one `open` row per Offer). */
const OPEN_ROW_KEY = 'offer_post_reviews_open_offer_key';

/** The history kinds of a seller's submit: queued (`submitted`) or published at once. */
const SUBMIT_HISTORY_KINDS = ['submitted', 'published'];

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

function reviewOf(row: Row): OfferPostReview {
  return OfferPostReview.restore({
    id: row.id as Id<'OfferPostReview'>,
    marketId: row.marketId as MarketId,
    offerId: row.offerId as Id<'Offer'>,
    sellerId: row.sellerId as Id<'Seller'>,
    productId: row.productId as Id<'Product'>,
    status: row.status as OfferPostReviewStatus,
    reasons: Object.freeze([...row.reasons]) as readonly OfferPostReviewReason[],
    samplePercent: row.samplePercent,
    sampleDoubled: row.sampleDoubled,
    openedAt: toInstant(row.openedAt),
    updatedAt: toInstant(row.updatedAt),
    decidedAt: row.decidedAt === null ? null : toInstant(row.decidedAt),
    decidedByAccountId: row.decidedByAccountId as Id<'Account'> | null,
    decisionReasonCode: row.decisionReasonCode as OfferChangeReason | null,
    misconduct: row.misconduct,
    note: row.note,
    version: row.version,
  });
}

/**
 * {@link OfferPostReviewRepository} over Prisma, in the caller's unit. Every `where` leads with
 * the caller's Market. A change is one conditional update on the version read, so two deciders
 * cannot both win; the guard trigger refuses any other change of a decided row and every DELETE.
 */
export class PrismaOfferPostReviewRepository implements OfferPostReviewRepository {
  constructor(private readonly prisma: PrismaService) {}

  async insert(market: MarketContext, review: OfferPostReview): Promise<void> {
    const state = review.state;
    if (!review.isNew) throw new Error('insert: the row is already stored');
    if (state.marketId !== market.marketId) throw new Error('insert: the row is of another Market');
    try {
      await this.prisma.tx(market).catalogOfferPostReview.create({
        data: {
          id: state.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          offerId: state.offerId,
          sellerId: state.sellerId,
          productId: state.productId,
          status: state.status,
          reasons: [...state.reasons],
          samplePercent: state.samplePercent,
          sampleDoubled: state.sampleDoubled,
          openedAt: toDate(state.openedAt),
          updatedAt: toDate(state.updatedAt),
          version: state.version,
        },
        select: { id: true },
      });
    } catch (error) {
      // Another unit opened a row for this Offer first: the caller asks again.
      if (this.prisma.violatedConstraint(error) === OPEN_ROW_KEY) {
        throw new StaleAggregateError('offer-post-review', state.offerId);
      }
      throw error;
    }
  }

  async save(market: MarketContext, review: OfferPostReview): Promise<boolean> {
    const state = review.state;
    if (!review.changed) throw new Error('save: nothing changed');
    const { count } = await this.prisma.tx(market).catalogOfferPostReview.updateMany({
      where: { marketId: market.marketId, id: state.id, version: review.loadedVersion },
      data: {
        status: state.status,
        reasons: [...state.reasons],
        samplePercent: state.samplePercent,
        sampleDoubled: state.sampleDoubled,
        updatedAt: toDate(state.updatedAt),
        decidedAt: state.decidedAt === null ? null : toDate(state.decidedAt),
        decidedByAccountId: state.decidedByAccountId,
        decisionReasonCode: state.decisionReasonCode,
        misconduct: state.misconduct,
        note: state.note,
        version: state.version,
      },
    });
    return count === 1;
  }

  async receive(market: MarketContext, receipt: OfferPostReviewReasonReceipt): Promise<boolean> {
    const { count } = await this.prisma.tx(market).catalogOfferPostReviewReason.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          offerId: receipt.offerId,
          reason: receipt.reason,
          sourceRef: receipt.sourceRef,
          postReviewId: receipt.postReviewId,
          receivedAt: toDate(receipt.receivedAt),
        },
      ],
      skipDuplicates: true,
    });
    return count === 1;
  }

  async received(
    market: MarketContext,
    key: Pick<OfferPostReviewReasonReceipt, 'offerId' | 'reason' | 'sourceRef'>,
  ): Promise<boolean> {
    // The primary key's columns as a plain filter: the Market guard reads `marketId` at the top.
    const row = await this.prisma.tx(market).catalogOfferPostReviewReason.findFirst({
      where: {
        marketId: market.marketId,
        offerId: key.offerId,
        reason: key.reason,
        sourceRef: key.sourceRef,
      },
      select: { postReviewId: true },
    });
    return row !== null;
  }

  async findOpenByOffer(
    market: MarketContext,
    offerId: Id<'Offer'>,
  ): Promise<OfferPostReview | null> {
    const row = await this.prisma.tx(market).catalogOfferPostReview.findFirst({
      where: { marketId: market.marketId, offerId, status: 'open' },
    });
    return row === null ? null : reviewOf(row);
  }

  async findById(
    market: MarketContext,
    id: Id<'OfferPostReview'>,
  ): Promise<OfferPostReview | null> {
    const row = await this.prisma.tx(market).catalogOfferPostReview.findFirst({
      where: { marketId: market.marketId, id },
    });
    return row === null ? null : reviewOf(row);
  }

  async findManyByIds(
    market: MarketContext,
    ids: readonly Id<'OfferPostReview'>[],
  ): Promise<readonly OfferPostReview[]> {
    if (ids.length === 0) return [];
    const rows = await this.prisma.tx(market).catalogOfferPostReview.findMany({
      where: { marketId: market.marketId, id: { in: [...ids] } },
    });
    return rows.map(reviewOf);
  }

  async everTakenDown(market: MarketContext, offerId: Id<'Offer'>): Promise<boolean> {
    const row = await this.prisma.tx(market).catalogOfferPostReview.findFirst({
      where: { marketId: market.marketId, offerId, status: 'taken-down' },
      select: { id: true },
    });
    return row !== null;
  }

  async list(
    market: MarketContext,
    page: OfferPostReviewPage,
    filter: OfferPostReviewFilter,
  ): Promise<readonly OfferPostReview[]> {
    const rows = await this.prisma.tx(market).catalogOfferPostReview.findMany({
      where: listWhere(market, filter),
      orderBy:
        page.sort === 'decided'
          ? [
              // In a status tab decided_at is never null (or always null, open), so the plain
              // order lets `offer_post_reviews_decided_idx` serve it; only "All" mixes open rows
              // in and puts them last (Mojtaba M1).
              filter.status === undefined
                ? { decidedAt: { sort: page.direction, nulls: 'last' as const } }
                : { decidedAt: page.direction },
              { openedAt: page.direction },
              { id: page.direction },
            ]
          : [{ openedAt: page.direction }, { id: page.direction }],
      ...(page.offset === 0 ? {} : { skip: page.offset }),
      take: page.limit,
    });
    return rows.map(reviewOf);
  }

  async count(market: MarketContext, filter: OfferPostReviewFilter): Promise<number> {
    return this.prisma.tx(market).catalogOfferPostReview.count({
      where: listWhere(market, filter),
    });
  }

  async sellerIds(
    market: MarketContext,
    status: OfferPostReviewStatus | undefined,
    limit: number,
  ): Promise<readonly Id<'Seller'>[]> {
    // GROUP BY without ORDER BY/LIMIT, so the status index picks the rows (as the review queue's
    // seller options, Sajad B1 on PR #1364); sorted and capped here.
    const groups = await this.prisma.tx(market).catalogOfferPostReview.groupBy({
      by: ['sellerId'],
      where: { marketId: market.marketId, ...(status === undefined ? {} : { status }) },
    });
    return groups
      .map((group) => group.sellerId)
      .sort()
      .slice(0, limit) as Id<'Seller'>[];
  }

  async submitterAccountIds(
    market: MarketContext,
    offerId: Id<'Offer'>,
  ): Promise<ReadonlySet<Id<'Account'>>> {
    const rows = await this.prisma.tx(market).catalogOfferHistory.findMany({
      where: {
        marketId: market.marketId,
        offerId,
        changeKind: { in: SUBMIT_HISTORY_KINDS },
        actorKind: 'seller',
      },
      select: { actorAccountId: true, actingAdminAccountId: true },
    });
    const ids = new Set<Id<'Account'>>();
    for (const row of rows) {
      if (row.actorAccountId !== null) ids.add(row.actorAccountId as Id<'Account'>);
      if (row.actingAdminAccountId !== null) ids.add(row.actingAdminAccountId as Id<'Account'>);
    }
    return ids;
  }
}

/**
 * The `where` of the list and its count, so both keep the same rows. `market_id` and `status`
 * lead (the list index `(market_id, status, opened_at, id)`); the category and the text search
 * reach the Offer's product through uncorrelated relation filters on catalog's own tables, as the
 * held-edit list's do (fine while the rows are a work list; see review-queue-search.ts).
 */
function listWhere(market: MarketContext, filter: OfferPostReviewFilter) {
  const and: Prisma.CatalogOfferPostReviewWhereInput[] = [];
  if (filter.search !== undefined) {
    and.push({ offer: { is: offerQueueSearchWhere(filter.search) } });
  }
  if (filter.categoryId !== undefined) {
    and.push({
      offer: {
        is: {
          product: {
            is: {
              publishedRevision: {
                is: { categories: { some: { categoryId: filter.categoryId } } },
              },
            },
          },
        },
      },
    });
  }
  return {
    marketId: market.marketId,
    ...(filter.status === undefined ? {} : { status: filter.status }),
    ...(filter.sellerId === undefined ? {} : { sellerId: filter.sellerId }),
    ...(filter.reasons === undefined || filter.reasons.length === 0
      ? {}
      : { reasons: { hasSome: [...filter.reasons] } }),
    ...instantRangeOn('openedAt', {
      from: filter.openedFrom ?? null,
      to: filter.openedTo ?? null,
    }),
    ...(and.length === 0 ? {} : { AND: and }),
  } satisfies Prisma.CatalogOfferPostReviewWhereInput;
}
