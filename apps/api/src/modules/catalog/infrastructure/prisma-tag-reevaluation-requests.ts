import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { CatalogTagReevaluationRequest, Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  CERTIFICATION_CAUSES,
  ENDING_CAUSES,
  NO_COUNTS,
  type CertificationCause,
  type PendingCertificationReevaluation,
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

const isCause = (value: string | null): value is CertificationCause =>
  (CERTIFICATION_CAUSES as readonly (string | null)[]).includes(value);

const jsonOf = (counts: ReevaluationCounts): Prisma.InputJsonObject =>
  Object.fromEntries(COUNT_KEYS.map((key) => [key, counts[key]]));

/** One stored request as the job reads it. */
function pendingOf(row: CatalogTagReevaluationRequest): PendingReevaluation[] {
  const common = {
    id: row.id as Id<'TagReevaluationRequest'>,
    cursorOfferId: row.cursorOfferId as Id<'Offer'> | null,
    counts: countsOf(row.counts),
    createdAt: Temporal.Instant.fromEpochMilliseconds(row.createdAt.getTime()),
  };
  if (
    row.kind === 'revision-published' &&
    row.productId !== null &&
    row.productRevisionId !== null
  ) {
    return [
      {
        ...common,
        kind: 'revision-published',
        productId: row.productId as Id<'Product'>,
        productRevisionId: row.productRevisionId as Id<'ProductRevision'>,
      },
    ];
  }
  if (
    row.kind === 'certification-event' &&
    isCause(row.cause) &&
    row.subjectId !== null &&
    row.sourceEventId !== null
  ) {
    return [
      {
        ...common,
        kind: 'certification-event',
        cause: row.cause,
        subjectId: row.subjectId as Id,
        sourceEventId: row.sourceEventId as Id,
      },
    ];
  }
  // A row this build cannot read (the CHECKs make it unreachable): never settled here.
  return [];
}

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

  async requestForEvent(
    market: MarketContext,
    request: {
      readonly id: Id<'TagReevaluationRequest'>;
      readonly cause: CertificationCause;
      readonly subjectId: Id;
      readonly sourceEventId: Id;
      readonly now: Temporal.Instant;
    },
  ): Promise<void> {
    // `createMany` with `skipDuplicates` is `ON CONFLICT DO NOTHING`: a second write of the same
    // event leaves the first request as it is (the unit stays usable, no 23505).
    await this.prisma.tx(market).catalogTagReevaluationRequest.createMany({
      data: [
        {
          id: request.id,
          marketId: market.marketId,
          tenantId: market.tenantId,
          kind: 'certification-event',
          productId: null,
          productRevisionId: null,
          sourceEventId: request.sourceEventId,
          cause: request.cause,
          subjectId: request.subjectId,
          state: 'pending',
          cursorOfferId: null,
          counts: jsonOf(NO_COUNTS),
          createdAt: toDate(request.now),
          settledAt: null,
        },
      ],
      skipDuplicates: true,
    });
  }

  async listPending(market: MarketContext, limit: number): Promise<readonly PendingReevaluation[]> {
    // Served by the claim index (`state = 'pending'`). The kinds this build settles are named in
    // WHERE, before LIMIT, so a pending row of a later kind never takes a slot (Hassan I-2). The
    // ending causes go first (Hassan M-1): one read of them, then the rest fills the page.
    const tx = this.prisma.tx(market);
    const order = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];
    const ending = await tx.catalogTagReevaluationRequest.findMany({
      where: {
        marketId: market.marketId,
        state: 'pending',
        kind: 'certification-event',
        cause: { in: [...ENDING_CAUSES] },
      },
      orderBy: order,
      take: limit,
    });
    const rest =
      ending.length >= limit
        ? []
        : await tx.catalogTagReevaluationRequest.findMany({
            where: {
              marketId: market.marketId,
              state: 'pending',
              kind: { in: ['revision-published', 'certification-event'] },
              id: { notIn: ending.map((row) => row.id) },
            },
            orderBy: order,
            take: limit - ending.length,
          });
    return [...ending, ...rest].flatMap((row) => pendingOf(row));
  }

  async listPendingEnding(
    market: MarketContext,
    page: { readonly afterId: Id<'TagReevaluationRequest'> | null; readonly limit: number },
  ): Promise<readonly PendingCertificationReevaluation[]> {
    const rows = await this.prisma.tx(market).catalogTagReevaluationRequest.findMany({
      where: {
        marketId: market.marketId,
        state: 'pending',
        kind: 'certification-event',
        cause: { in: [...ENDING_CAUSES] },
        ...(page.afterId === null ? {} : { id: { gt: page.afterId } }),
      },
      orderBy: { id: 'asc' },
      take: page.limit,
    });
    return rows.flatMap((row) => {
      const pending = pendingOf(row);
      return pending.filter(
        (item): item is PendingCertificationReevaluation => item.kind === 'certification-event',
      );
    });
  }

  async progress(
    market: MarketContext,
    id: Id<'TagReevaluationRequest'>,
    update: { readonly cursorOfferId: Id<'Offer'> | null; readonly counts: ReevaluationCounts },
  ): Promise<boolean> {
    const cursor = update.cursorOfferId;
    const { count } = await this.prisma.tx(market).catalogTagReevaluationRequest.updateMany({
      where: {
        marketId: market.marketId,
        id,
        state: 'pending',
        // Never back: forward, or equal (counts only); no cursor only while none is stored.
        ...(cursor === null
          ? { cursorOfferId: null }
          : { OR: [{ cursorOfferId: null }, { cursorOfferId: { lte: cursor } }] }),
      },
      data: {
        ...(cursor === null ? {} : { cursorOfferId: cursor }),
        counts: jsonOf(update.counts),
      },
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
