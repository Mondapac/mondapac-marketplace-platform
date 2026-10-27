import { Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  AccountDeletionSettingsRecord,
  AccountDeletionSettingsRepository,
} from '../application/ports/account-deletion-settings.repository';

/** {@link AccountDeletionSettingsRepository} on `customers.account_deletion_settings`, scoped by `marketId`. */
export class PrismaAccountDeletionSettingsRepository implements AccountDeletionSettingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async latest(market: MarketContext): Promise<AccountDeletionSettingsRecord | null> {
    const row = await this.prisma.tx(market).customersAccountDeletionSettings.findFirst({
      where: { marketId: market.marketId },
      orderBy: { version: 'desc' },
    });
    if (row === null) return null;
    return {
      version: row.version,
      settings: { enabled: row.enabled, waitingPeriodDays: row.waitingPeriodDays },
      changedAt: Temporal.Instant.fromEpochMilliseconds(row.changedAt.getTime()),
    };
  }

  async append(
    market: MarketContext,
    record: Parameters<AccountDeletionSettingsRepository['append']>[1],
  ): Promise<boolean> {
    const created = await this.prisma.tx(market).customersAccountDeletionSettings.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          version: record.version,
          enabled: record.settings.enabled,
          waitingPeriodDays: record.settings.waitingPeriodDays,
          reason: record.reason,
          changedAt: new Date(record.changedAt.epochMilliseconds),
          changedBy: record.changedBy,
        },
      ],
      skipDuplicates: true,
    });
    return created.count === 1;
  }
}
