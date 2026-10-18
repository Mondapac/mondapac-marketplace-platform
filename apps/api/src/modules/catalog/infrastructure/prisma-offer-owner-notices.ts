import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  DueOfferOwnerNotice,
  OfferOwnerNoticeOutcome,
  OfferOwnerNoticeRepository,
  OfferOwnerNoticeDraft,
} from '../application/ports/offer-owner-notice.repository';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

/** {@link OfferOwnerNoticeRepository} on `catalog.offer_owner_notices` (data design 3.27). */
export class PrismaOfferOwnerNotices implements OfferOwnerNoticeRepository {
  constructor(private readonly prisma: PrismaService) {}

  async enqueue(
    market: MarketContext,
    batch: {
      readonly sourceEventId: Id;
      readonly productCertificationId: Id;
      readonly thresholdDays: number;
      readonly notices: readonly OfferOwnerNoticeDraft[];
      readonly now: Temporal.Instant;
    },
  ): Promise<number> {
    if (batch.notices.length === 0) return 0;
    const now = toDate(batch.now);
    // `skipDuplicates` is `ON CONFLICT DO NOTHING` on the event-and-Owner unique: the unit stays
    // usable and the first rows stay as they are.
    const { count } = await this.prisma.tx(market).catalogOfferOwnerNotice.createMany({
      data: batch.notices.map((notice) => ({
        id: notice.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        sourceEventId: batch.sourceEventId,
        productCertificationId: batch.productCertificationId,
        thresholdDays: batch.thresholdDays,
        sellerId: notice.sellerId,
        typeCode: notice.typeCode,
        offers: notice.offers,
        validUntil: toDate(notice.validUntil),
        state: 'pending',
        outcome: null,
        attempts: 0,
        nextAttemptAt: now,
        createdAt: now,
        settledAt: null,
      })),
      skipDuplicates: true,
    });
    return count;
  }

  async due(
    market: MarketContext,
    now: Temporal.Instant,
    limit: number,
  ): Promise<readonly DueOfferOwnerNotice[]> {
    // The claim index `(market_id, next_attempt_at, id) WHERE state = 'pending'`.
    const rows = await this.prisma.tx(market).catalogOfferOwnerNotice.findMany({
      where: { marketId: market.marketId, state: 'pending', nextAttemptAt: { lte: toDate(now) } },
      orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: {
        id: true,
        sellerId: true,
        typeCode: true,
        offers: true,
        validUntil: true,
        attempts: true,
      },
    });
    return rows.map((row) => ({
      id: row.id as Id<'OfferOwnerNotice'>,
      sellerId: row.sellerId as Id<'Seller'>,
      typeCode: row.typeCode,
      offers: row.offers,
      validUntil: toInstant(row.validUntil),
      attempts: row.attempts,
    }));
  }

  async settle(
    market: MarketContext,
    id: Id<'OfferOwnerNotice'>,
    end:
      | { readonly state: 'sent'; readonly attempts: number }
      | {
          readonly state: 'skipped' | 'failed';
          readonly outcome: OfferOwnerNoticeOutcome;
          readonly attempts: number;
        },
    now: Temporal.Instant,
  ): Promise<boolean> {
    const { count } = await this.prisma.tx(market).catalogOfferOwnerNotice.updateMany({
      where: { marketId: market.marketId, id, state: 'pending' },
      data: {
        state: end.state,
        outcome: end.state === 'sent' ? null : end.outcome,
        attempts: end.attempts,
        settledAt: toDate(now),
      },
    });
    return count === 1;
  }

  async defer(
    market: MarketContext,
    id: Id<'OfferOwnerNotice'>,
    retry: { readonly attempts: number; readonly nextAttemptAt: Temporal.Instant },
  ): Promise<boolean> {
    const { count } = await this.prisma.tx(market).catalogOfferOwnerNotice.updateMany({
      where: { marketId: market.marketId, id, state: 'pending' },
      data: { attempts: retry.attempts, nextAttemptAt: toDate(retry.nextAttemptAt) },
    });
    return count === 1;
  }
}
