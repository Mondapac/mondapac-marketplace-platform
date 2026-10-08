import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  RefusalAdmission,
  WriteRefusalThrottleRepository,
} from '../application/ports/write-refusal-throttle.repository';

/**
 * What the per-actor counter allows for one refusal: `record` (a slot under the cap),
 * `summarise` (the first refusal past it), `suppress` (nothing).
 */
export type ActorRefusalSlot = 'record' | 'summarise' | 'suppress';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

const assertWindow = (name: string, windowMs: number): void => {
  if (!Number.isInteger(windowMs) || windowMs <= 0) {
    throw new RangeError(`${name}: windowMs must be a positive integer`);
  }
};

/**
 * {@link WriteRefusalThrottleRepository} on `pricing.write_refusal_throttles` and
 * `pricing.write_refusal_actor_throttles` (pricing-data 3.8, the pattern of identity's
 * `sign_in_throttles`). Each decision is a conditional single-row `updateMany`, then a
 * `createMany` that skips an existing row: under READ COMMITTED a concurrent call waits on the
 * row and re-checks the condition against the committed value, so two calls never both win a
 * window or a slot under the cap. No read-then-write.
 *
 * The two counter steps are public for the database tests; the port exposes only
 * {@link admitRefusal}, the one place that takes the rows, actor row first (lock order, port).
 */
export class PrismaWriteRefusalThrottleRepository implements WriteRefusalThrottleRepository {
  constructor(private readonly prisma: PrismaService) {}

  async admitRefusal(
    market: MarketContext,
    actorAccountId: Id<'Account'>,
    offerId: Id<'Offer'>,
    now: Temporal.Instant,
    windowMs: number,
    cap: number,
  ): Promise<RefusalAdmission> {
    // 1. The actor row (locked from here to the end of the unit).
    const slot = await this.countActorRefusal(market, actorAccountId, now, windowMs, cap);
    if (slot === 'suppress') return { kind: 'none' };
    if (slot === 'summarise') {
      const row = await this.prisma.tx(market).pricingWriteRefusalActorThrottle.findFirst({
        where: { marketId: market.marketId, actorAccountId },
        select: { windowStartedAt: true },
      });
      if (row === null) throw new Error('admitRefusal: the actor counter row is missing');
      return {
        kind: 'summarise',
        windowStartedAt: Temporal.Instant.fromEpochMilliseconds(row.windowStartedAt.getTime()),
      };
    }
    // 2. Then the (actor, Offer) row.
    if (await this.claimOfferWindow(market, actorAccountId, offerId, now, windowMs)) {
      return { kind: 'record' };
    }
    // The pair already has its row this minute: give the slot back on the row this unit holds.
    const released = await this.prisma.tx(market).pricingWriteRefusalActorThrottle.updateMany({
      where: { marketId: market.marketId, actorAccountId, recordedCount: { gt: 0 } },
      data: { recordedCount: { decrement: 1 } },
    });
    if (released.count !== 1) throw new Error('admitRefusal: the slot could not be given back');
    return { kind: 'none' };
  }

  async claimOfferWindow(
    market: MarketContext,
    actorAccountId: Id<'Account'>,
    offerId: Id<'Offer'>,
    now: Temporal.Instant,
    windowMs: number,
  ): Promise<boolean> {
    assertWindow('claimOfferWindow', windowMs);
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
    assertWindow('countActorRefusal', windowMs);
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

  async purgeActorWindowsStartedBefore(
    market: MarketContext,
    before: Temporal.Instant,
  ): Promise<number> {
    const { count } = await this.prisma.tx(market).pricingWriteRefusalActorThrottle.deleteMany({
      where: { marketId: market.marketId, windowStartedAt: { lt: toDate(before) } },
    });
    return count;
  }

  async purgeOfferWindowsStartedBefore(
    market: MarketContext,
    before: Temporal.Instant,
  ): Promise<number> {
    const { count } = await this.prisma.tx(market).pricingWriteRefusalThrottle.deleteMany({
      where: { marketId: market.marketId, windowStartedAt: { lt: toDate(before) } },
    });
    return count;
  }
}
