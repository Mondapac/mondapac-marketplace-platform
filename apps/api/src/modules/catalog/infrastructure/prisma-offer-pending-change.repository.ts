import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, MarketId } from '@mondapac/shared-kernel';
import type { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { StaleAggregateError } from '../../../platform/unit-of-work/errors';
import { instantRangeOn } from '../../../platform/list-query';
import type {
  OfferChangePage,
  OfferChangeQueueFilter,
  OfferPendingChangeRepository,
} from '../application/ports/offer-pending-change.repository';
import type { OfferHandling } from '../domain/offer-handling';
import {
  OfferPendingChange,
  type OfferChangeSupersededCause,
  type OfferPendingChangeStatus,
} from '../domain/offer-pending-change';
import type { OfferReviewReason } from '../domain/offer-review-policy';
import { offerQueueSearchWhere } from './review-queue-search';

type Row = Prisma.CatalogOfferPendingChangeGetPayload<object>;

/** The partial unique of the open change (one `pending` row per Offer). */
const OPEN_CHANGE_KEY = 'offer_pending_changes_open_offer_key';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

function changeOf(row: Row): OfferPendingChange {
  return OfferPendingChange.restore({
    id: row.id as Id<'OfferPendingChange'>,
    marketId: row.marketId as MarketId,
    offerId: row.offerId as Id<'Offer'>,
    sellerId: row.sellerId as Id<'Seller'>,
    baseOfferVersion: row.baseOfferVersion,
    proposedDescription:
      row.proposedDescription === null
        ? null
        : Object.freeze({ ...(row.proposedDescription as Record<string, string>) }),
    proposedHandling: row.proposedHandling as OfferHandling | null,
    proposedTagTypes: Object.freeze([...row.proposedTagTypes]),
    reasons: Object.freeze([...row.reasons]) as readonly OfferReviewReason[],
    policyVersion: row.policyVersion,
    status: row.status as OfferPendingChangeStatus,
    supersededCause: row.supersededCause as OfferChangeSupersededCause | null,
    submittedAt: toInstant(row.submittedAt),
    submittedByAccountId: row.submittedByAccountId as Id<'Account'>,
    decidedAt: row.decidedAt === null ? null : toInstant(row.decidedAt),
    decidedByAccountId: row.decidedByAccountId as Id<'Account'> | null,
    decisionNote: row.decisionNote,
  });
}

/**
 * {@link OfferPendingChangeRepository} over Prisma, in the caller's unit. The decision is one
 * conditional update on `status = 'pending'`, so two deciders cannot both win; the guard trigger
 * refuses any other change of a decided row and every DELETE.
 */
export class PrismaOfferPendingChangeRepository implements OfferPendingChangeRepository {
  constructor(private readonly prisma: PrismaService) {}

  async insert(market: MarketContext, change: OfferPendingChange): Promise<void> {
    const state = change.state;
    if (!change.isNew) throw new Error('insert: the change is already stored');
    if (state.marketId !== market.marketId)
      throw new Error('insert: the change is of another Market');
    try {
      await this.prisma.tx(market).catalogOfferPendingChange.create({
        data: {
          id: state.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          offerId: state.offerId,
          sellerId: state.sellerId,
          baseOfferVersion: state.baseOfferVersion,
          ...(state.proposedDescription === null
            ? {}
            : { proposedDescription: { ...state.proposedDescription } }),
          proposedHandling: state.proposedHandling,
          proposedTagTypes: [...state.proposedTagTypes],
          reasons: [...state.reasons],
          policyVersion: state.policyVersion,
          status: state.status,
          submittedAt: toDate(state.submittedAt),
          submittedByAccountId: state.submittedByAccountId,
        },
        select: { id: true },
      });
    } catch (error) {
      // Another unit opened a change for this Offer first: the caller asks again.
      if (this.prisma.violatedConstraint(error) === OPEN_CHANGE_KEY) {
        throw new StaleAggregateError('offer-pending-change', state.offerId);
      }
      throw error;
    }
  }

  async decide(market: MarketContext, change: OfferPendingChange): Promise<boolean> {
    const state = change.state;
    if (!change.decided || state.decidedAt === null) throw new Error('decide: nothing decided');
    const { count } = await this.prisma.tx(market).catalogOfferPendingChange.updateMany({
      where: { marketId: market.marketId, id: state.id, status: 'pending' },
      data: {
        status: state.status,
        supersededCause: state.supersededCause,
        decidedAt: toDate(state.decidedAt),
        decidedByAccountId: state.decidedByAccountId,
        decisionNote: state.decisionNote,
      },
    });
    return count === 1;
  }

  async findOpenByOffer(
    market: MarketContext,
    offerId: Id<'Offer'>,
  ): Promise<OfferPendingChange | null> {
    const row = await this.prisma.tx(market).catalogOfferPendingChange.findFirst({
      where: { marketId: market.marketId, offerId, status: 'pending' },
    });
    return row === null ? null : changeOf(row);
  }

  async findLatestByOffer(
    market: MarketContext,
    offerId: Id<'Offer'>,
  ): Promise<OfferPendingChange | null> {
    const row = await this.prisma.tx(market).catalogOfferPendingChange.findFirst({
      where: { marketId: market.marketId, offerId },
      orderBy: [{ submittedAt: 'desc' }, { id: 'desc' }],
    });
    return row === null ? null : changeOf(row);
  }

  async findById(
    market: MarketContext,
    id: Id<'OfferPendingChange'>,
  ): Promise<OfferPendingChange | null> {
    const row = await this.prisma.tx(market).catalogOfferPendingChange.findFirst({
      where: { marketId: market.marketId, id },
    });
    return row === null ? null : changeOf(row);
  }

  async listPending(
    market: MarketContext,
    page: OfferChangePage,
    filter: OfferChangeQueueFilter = {},
  ): Promise<readonly OfferPendingChange[]> {
    const cursor = page.after;
    const direction = page.direction ?? 'asc';
    if (cursor !== null && direction !== 'asc') throw new Error('listPending: keyset is ascending');
    const after =
      cursor === null
        ? {}
        : {
            // The range bound lets the index start at the cursor instead of scanning every
            // earlier row for the OR (Mojtaba F1 on PR #1350).
            submittedAt: { gte: toDate(cursor.submittedAt) },
            OR: [
              { submittedAt: { gt: toDate(cursor.submittedAt) } },
              { submittedAt: toDate(cursor.submittedAt), id: { gt: cursor.id } },
            ],
          };
    const where = queueWhere(market, filter);
    const rows = await this.prisma.tx(market).catalogOfferPendingChange.findMany({
      where: {
        ...where,
        ...after,
        // The submit range and the cursor bound both constrain `submitted_at`: keep both.
        ...(cursor !== null && where.submittedAt !== undefined
          ? { AND: [...(where.AND ?? []), { submittedAt: where.submittedAt }] }
          : {}),
      },
      orderBy: [{ submittedAt: direction }, { id: direction }],
      ...(page.offset === undefined || page.offset === 0 ? {} : { skip: page.offset }),
      take: page.limit,
    });
    return rows.map(changeOf);
  }

  async countPending(market: MarketContext, filter: OfferChangeQueueFilter = {}): Promise<number> {
    return this.prisma.tx(market).catalogOfferPendingChange.count({
      where: queueWhere(market, filter),
    });
  }

  async pendingSellerIds(market: MarketContext, limit: number): Promise<readonly Id<'Seller'>[]> {
    // GROUP BY over the pending rows only (the queue index leads with market_id, status).
    const groups = await this.prisma.tx(market).catalogOfferPendingChange.groupBy({
      by: ['sellerId'],
      where: { marketId: market.marketId, status: 'pending' },
      orderBy: { sellerId: 'asc' },
      take: limit,
    });
    return groups.map((group) => group.sellerId as Id<'Seller'>);
  }
}

/**
 * The `where` of the admin list and its count, so both keep the same rows. `market_id` and
 * `status` lead (the queue index `(market_id, status, submitted_at, id)`, Mojtaba's keyset
 * decision in slice 2c); seller, reasons and the submit window filter the few pending rows. The
 * category and the text search reach the Offer's product through uncorrelated relation filters
 * (same schema, catalog's own tables), as the review queue's search does: fine while the pending
 * rows are few (see review-queue-search.ts for the plan note).
 */
function queueWhere(market: MarketContext, filter: OfferChangeQueueFilter) {
  const and: Prisma.CatalogOfferPendingChangeWhereInput[] = [];
  if (filter.search !== undefined)
    and.push({ offer: { is: offerQueueSearchWhere(filter.search) } });
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
    status: 'pending',
    ...(filter.sellerId === undefined ? {} : { sellerId: filter.sellerId }),
    ...(filter.reasons === undefined || filter.reasons.length === 0
      ? {}
      : { reasons: { hasSome: [...filter.reasons] } }),
    ...instantRangeOn('submittedAt', {
      from: filter.submittedFrom ?? null,
      to: filter.submittedTo ?? null,
    }),
    ...(and.length === 0 ? {} : { AND: and }),
  } satisfies Prisma.CatalogOfferPendingChangeWhereInput;
}
