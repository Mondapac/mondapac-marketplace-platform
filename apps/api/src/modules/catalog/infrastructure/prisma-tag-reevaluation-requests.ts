import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  NO_COUNTS,
  type PendingReevaluation,
  type ReevaluationCounts,
  type TagReevaluationRequestRepository,
} from '../application/ports/tag-reevaluation-requests';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

const COUNT_KEYS = ['asked', 'kept', 'switched', 'suspended', 'restored', 'unavailable'] as const;

/** The stored counts, each a non-negative integer; anything else reads as zero. */
function countsOf(value: unknown): ReevaluationCounts {
  const raw = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const out: Record<string, number> = { ...NO_COUNTS };
  for (const key of COUNT_KEYS) {
    const n = raw[key];
    if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0) out[key] = n;
  }
  return out as unknown as ReevaluationCounts;
}

const jsonOf = (counts: ReevaluationCounts): Prisma.InputJsonObject =>
  Object.fromEntries(COUNT_KEYS.map((key) => [key, counts[key]]));

/**
 * {@link TagReevaluationRequestRepository} on `catalog.tag_reevaluation_requests` (data design
 * 3.18). Every statement carries `market_id` at the top level of `where`; the partial uniques and
 * the claim index are literal predicates (`state = 'pending'`), which the plans keep under
 * unnamed statements (platform.md 10.9).
 */
export class PrismaTagReevaluationRequests implements TagReevaluationRequestRepository {
  constructor(private readonly prisma: PrismaService) {}

  async requestForPublish(
    market: MarketContext,
    request: {
      readonly id: Id<'TagReevaluationRequest'>;
      readonly productId: Id<'Product'>;
      readonly productRevisionId: Id<'ProductRevision'>;
      readonly now: Temporal.Instant;
    },
  ): Promise<void> {
    const tx = this.prisma.tx(market);
    await tx.catalogTagReevaluationRequest.updateMany({
      where: {
        marketId: market.marketId,
        productId: request.productId,
        kind: 'revision-published',
        state: 'pending',
      },
      data: { state: 'superseded', settledAt: toDate(request.now) },
    });
    await tx.catalogTagReevaluationRequest.create({
      data: {
        id: request.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        kind: 'revision-published',
        productId: request.productId,
        productRevisionId: request.productRevisionId,
        sourceEventId: null,
        state: 'pending',
        cursorOfferId: null,
        counts: jsonOf(NO_COUNTS),
        createdAt: toDate(request.now),
        settledAt: null,
      },
      select: { id: true },
    });
  }

  async listPending(market: MarketContext, limit: number): Promise<readonly PendingReevaluation[]> {
    const rows = await this.prisma.tx(market).catalogTagReevaluationRequest.findMany({
      where: { marketId: market.marketId, state: 'pending', kind: 'revision-published' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.flatMap((row) =>
      row.productId === null || row.productRevisionId === null
        ? []
        : [
            {
              id: row.id as Id<'TagReevaluationRequest'>,
              productId: row.productId as Id<'Product'>,
              productRevisionId: row.productRevisionId as Id<'ProductRevision'>,
              cursorOfferId: row.cursorOfferId as Id<'Offer'> | null,
              counts: countsOf(row.counts),
            },
          ],
    );
  }

  async progress(
    market: MarketContext,
    id: Id<'TagReevaluationRequest'>,
    update: { readonly cursorOfferId: Id<'Offer'>; readonly counts: ReevaluationCounts },
  ): Promise<boolean> {
    const { count } = await this.prisma.tx(market).catalogTagReevaluationRequest.updateMany({
      where: {
        marketId: market.marketId,
        id,
        state: 'pending',
        OR: [{ cursorOfferId: null }, { cursorOfferId: { lt: update.cursorOfferId } }],
      },
      data: { cursorOfferId: update.cursorOfferId, counts: jsonOf(update.counts) },
    });
    return count === 1;
  }

  async close(
    market: MarketContext,
    id: Id<'TagReevaluationRequest'>,
    end: {
      readonly state: 'settled' | 'superseded';
      readonly counts: ReevaluationCounts;
      readonly now: Temporal.Instant;
    },
  ): Promise<boolean> {
    const { count } = await this.prisma.tx(market).catalogTagReevaluationRequest.updateMany({
      where: { marketId: market.marketId, id, state: 'pending' },
      data: { state: end.state, counts: jsonOf(end.counts), settledAt: toDate(end.now) },
    });
    return count === 1;
  }
}
