import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
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

  async pageOfAccount(
    market: MarketContext,
    accountId: Id<'Account'>,
    direction: 'asc' | 'desc',
    window: { readonly offset: number; readonly limit: number },
  ) {
    const rows = await this.prisma.tx(market).notificationsCartReminder.findMany({
      where: { marketId: market.marketId, accountId },
      orderBy: [{ takenAt: direction }, { cartChangedAt: direction }, { stage: direction }],
      skip: window.offset,
      take: window.limit,
      select: { cartChangedAt: true, stage: true, takenAt: true },
    });
    return rows.map((row) => ({
      accountId,
      cartChangedAt: Temporal.Instant.fromEpochMilliseconds(row.cartChangedAt.getTime()),
      stage: row.stage === 2 ? (2 as const) : (1 as const),
      takenAt: Temporal.Instant.fromEpochMilliseconds(row.takenAt.getTime()),
    }));
  }

  countOfAccount(market: MarketContext, accountId: Id<'Account'>) {
    return this.prisma
      .tx(market)
      .notificationsCartReminder.count({ where: { marketId: market.marketId, accountId } });
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
