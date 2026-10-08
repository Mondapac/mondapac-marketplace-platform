import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  ActorRefusalSlot,
  WriteRefusalThrottleRepository,
} from '../application/ports/write-refusal-throttle.repository';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

/**
 * {@link WriteRefusalThrottleRepository} on `pricing.write_refusal_throttles` and
 * `pricing.write_refusal_actor_throttles` (pricing-data 3.8, the pattern of identity's
 * `sign_in_throttles`). Each decision is a conditional single-row `updateMany`, then a
 * `createMany` that skips an existing row: under READ COMMITTED a concurrent call waits on the
 * row and re-checks the condition against the committed value, so two calls never both win a
 * window or a slot under the cap. No read-then-write.
 */
export class PrismaWriteRefusalThrottleRepository implements WriteRefusalThrottleRepository {
  constructor(private readonly prisma: PrismaService) {}

  async claimOfferWindow(
    market: MarketContext,
    actorAccountId: Id<'Account'>,
    offerId: Id<'Offer'>,
    now: Temporal.Instant,
    windowMs: number,
  ): Promise<boolean> {
    const tx = this.prisma.tx(market);
    const expired = new Date(now.epochMilliseconds - windowMs);
    const renewed = await tx.pricingWriteRefusalThrottle.updateMany({
      where: {
        marketId: market.marketId,
        actorAccountId,
        offerId,
        windowStartedAt: { lte: expired },
      },
      data: { windowStartedAt: toDate(now) },
    });
    if (renewed.count === 1) return true;
    const created = await tx.pricingWriteRefusalThrottle.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          actorAccountId,
          offerId,
          windowStartedAt: toDate(now),
        },
      ],
      skipDuplicates: true,
    });
    return created.count === 1;
  }

  async countActorRefusal(
    market: MarketContext,
    actorAccountId: Id<'Account'>,
    now: Temporal.Instant,
    windowMs: number,
    cap: number,
  ): Promise<ActorRefusalSlot> {
    if (!Number.isInteger(cap) || cap < 1) throw new RangeError('countActorRefusal: cap >= 1');
    const tx = this.prisma.tx(market);
    const key = { marketId: market.marketId, actorAccountId };
    const expired = new Date(now.epochMilliseconds - windowMs);

    // A new window: this refusal is its first recorded row.
    const restarted = await tx.pricingWriteRefusalActorThrottle.updateMany({
      where: { ...key, windowStartedAt: { lte: expired } },
      data: { windowStartedAt: toDate(now), recordedCount: 1, suppressedCount: 0 },
    });
    if (restarted.count === 1) return 'record';
    const created = await tx.pricingWriteRefusalActorThrottle.createMany({
      data: [
        {
          ...key,
          tenantId: market.tenantId,
          windowStartedAt: toDate(now),
          recordedCount: 1,
          suppressedCount: 0,
        },
      ],
      skipDuplicates: true,
    });
    if (created.count === 1) return 'record';

    // The current window: a slot under the cap, else the first refusal past it writes the summary.
    const underCap = await tx.pricingWriteRefusalActorThrottle.updateMany({
      where: { ...key, recordedCount: { lt: cap } },
      data: { recordedCount: { increment: 1 } },
    });
    if (underCap.count === 1) return 'record';
    const first = await tx.pricingWriteRefusalActorThrottle.updateMany({
      where: { ...key, suppressedCount: 0 },
      data: { suppressedCount: 1 },
    });
    if (first.count === 1) return 'summarise';
    await tx.pricingWriteRefusalActorThrottle.updateMany({
      where: key,
      data: { suppressedCount: { increment: 1 } },
    });
    return 'suppress';
  }

  async purgeStartedBefore(market: MarketContext, before: Temporal.Instant): Promise<number> {
    const tx = this.prisma.tx(market);
    const where = { marketId: market.marketId, windowStartedAt: { lt: toDate(before) } };
    const offers = await tx.pricingWriteRefusalThrottle.deleteMany({ where });
    const actors = await tx.pricingWriteRefusalActorThrottle.deleteMany({ where });
    return offers.count + actors.count;
  }
}
