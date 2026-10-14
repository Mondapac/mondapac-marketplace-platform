import { Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  SupportContactRecord,
  SupportContactRepository,
} from '../application/ports/support-contact.repository';

/** {@link SupportContactRepository} on `notifications.support_contacts`, scoped by `marketId`. */
export class PrismaSupportContactRepository implements SupportContactRepository {
  constructor(private readonly prisma: PrismaService) {}

  async latest(market: MarketContext) {
    const row = await this.prisma.tx(market).notificationsSupportContact.findFirst({
      where: { marketId: market.marketId },
      orderBy: { version: 'desc' },
    });
    return row === null
      ? null
      : ({
          version: row.version,
          email: row.email,
          changedAt: Temporal.Instant.fromEpochMilliseconds(row.changedAt.getTime()),
        } satisfies SupportContactRecord);
  }

  async append(
    market: MarketContext,
    record: Parameters<SupportContactRepository['append']>[1],
  ): Promise<boolean> {
    const created = await this.prisma.tx(market).notificationsSupportContact.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          version: record.version,
          email: record.email,
          previousEmail: record.previousEmail,
          changedAt: new Date(record.changedAt.epochMilliseconds),
          changedBy: record.changedBy,
        },
      ],
      skipDuplicates: true,
    });
    return created.count === 1;
  }
}
