import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  PersonalizationSettingRecord,
  PersonalizationSettingRepository,
} from '../application/ports/personalization-setting.repository';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);
const toInstant = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());

/**
 * {@link PersonalizationSettingRepository} on `engagement.personalization_settings`, scoped by
 * `marketId` and the account in every `where`.
 */
export class PrismaPersonalizationSettingRepository implements PersonalizationSettingRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(
    market: MarketContext,
    accountId: Id<'Account'>,
  ): Promise<PersonalizationSettingRecord | null> {
    const row = await this.prisma.tx(market).engagementPersonalizationSetting.findFirst({
      where: { marketId: market.marketId, accountId },
    });
    if (row === null) return null;
    return {
      id: row.id as Id<'PersonalizationSetting'>,
      accountId: row.accountId as Id<'Account'>,
      enabled: row.enabled,
      changedAt: toInstant(row.changedAt),
      createdAt: toInstant(row.createdAt),
    };
  }

  async save(market: MarketContext, setting: PersonalizationSettingRecord): Promise<void> {
    const tx = this.prisma.tx(market);
    const changed = await tx.engagementPersonalizationSetting.updateMany({
      where: { marketId: market.marketId, accountId: setting.accountId },
      data: { enabled: setting.enabled, changedAt: toDate(setting.changedAt) },
    });
    if (changed.count > 0) return;
    await tx.engagementPersonalizationSetting.create({
      data: {
        id: setting.id,
        marketId: market.marketId,
        tenantId: market.tenantId,
        accountId: setting.accountId,
        enabled: setting.enabled,
        changedAt: toDate(setting.changedAt),
        createdAt: toDate(setting.createdAt),
      },
    });
  }

  async delete(market: MarketContext, accountId: Id<'Account'>): Promise<boolean> {
    const { count } = await this.prisma.tx(market).engagementPersonalizationSetting.deleteMany({
      where: { marketId: market.marketId, accountId },
    });
    return count > 0;
  }

  async lockAccount(
    market: MarketContext,
    accountId: Id<'Account'>,
    mode: 'shared' | 'exclusive',
  ): Promise<void> {
    await this.prisma.namedQuery(market, 'engagement.lock-account', { accountId, mode });
  }
}
