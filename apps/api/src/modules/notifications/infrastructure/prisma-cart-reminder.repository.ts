import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  CartReminderKey,
  CartReminderRepository,
} from '../application/ports/cart-reminder.repository';

const date = (at: Temporal.Instant) => new Date(at.epochMilliseconds);

/** {@link CartReminderRepository} on `notifications.cart_reminders`, scoped by `marketId`. */
export class PrismaCartReminderRepository implements CartReminderRepository {
  constructor(private readonly prisma: PrismaService) {}

  async take(market: MarketContext, key: CartReminderKey, at: Temporal.Instant) {
    const { count } = await this.prisma.tx(market).notificationsCartReminder.createMany({
      data: [
        {
          marketId: market.marketId,
          accountId: key.accountId,
          cartChangedAt: date(key.cartChangedAt),
          stage: key.stage,
          tenantId: market.tenantId,
          takenAt: date(at),
        },
      ],
      skipDuplicates: true,
    });
    return count === 1;
  }

  async purgeTakenBefore(market: MarketContext, cutoff: Temporal.Instant, limit: number) {
    const tx = this.prisma.tx(market);
    const expired = { marketId: market.marketId, takenAt: { lt: date(cutoff) } };
    const rows = await tx.notificationsCartReminder.findMany({
      where: expired,
      orderBy: { takenAt: 'asc' },
      take: limit,
      select: { accountId: true, cartChangedAt: true, stage: true },
    });
    if (rows.length === 0) return 0;
    const { count } = await tx.notificationsCartReminder.deleteMany({
      where: { ...expired, OR: rows },
    });
    return count;
  }
}
