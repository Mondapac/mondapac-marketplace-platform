import { Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  AssistantSettingsRecord,
  AssistantSettingsRepository,
} from '../application/ports/assistant-settings.repository';
import {
  AUDIENCES,
  MODEL_TIERS,
  REPLY_LANGUAGES,
  RETENTIONS,
  SCOPES,
  SUPPORT_HANDOFFS,
  USER_GROUPS,
  type AssistantSettings,
} from '../domain/assistant-settings';

/** A stored enum value; the table's CHECKs make anything else unreachable. */
function stored<T extends string>(options: readonly T[], value: string): T {
  if (!(options as readonly string[]).includes(value)) {
    throw new Error(`assistant.settings holds an unknown value "${value}"`);
  }
  return value as T;
}

/** {@link AssistantSettingsRepository} on `assistant.settings`, scoped by `marketId`. */
export class PrismaAssistantSettingsRepository implements AssistantSettingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async latest(market: MarketContext): Promise<AssistantSettingsRecord | null> {
    const row = await this.prisma.tx(market).assistantSettings.findFirst({
      where: { marketId: market.marketId },
      orderBy: { version: 'desc' },
    });
    if (row === null) return null;
    const settings: AssistantSettings = {
      enabled: row.enabled,
      audience: stored(AUDIENCES, row.audience),
      audiencePercent: row.audiencePercent,
      scope: stored(SCOPES, row.scope),
      modelTier: stored(MODEL_TIERS, row.modelTier),
      users: stored(USER_GROUPS, row.users),
      guestMessageLimit: row.guestMessageLimit,
      customerMessageLimit: row.customerMessageLimit,
      retention: stored(RETENTIONS, row.retention),
      replyLanguage: stored(REPLY_LANGUAGES, row.replyLanguage),
      dailySpendCapUsdCents: row.dailySpendCapUsdCents,
      monthlySpendCapUsdCents: row.monthlySpendCapUsdCents,
      supportHandoff: stored(SUPPORT_HANDOFFS, row.supportHandoff),
      welcomeText: row.welcomeText,
    };
    return {
      version: row.version,
      settings,
      changedAt: Temporal.Instant.fromEpochMilliseconds(row.changedAt.getTime()),
    };
  }

  async append(
    market: MarketContext,
    record: Parameters<AssistantSettingsRepository['append']>[1],
  ): Promise<boolean> {
    const created = await this.prisma.tx(market).assistantSettings.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          version: record.version,
          ...record.settings,
          changedAt: new Date(record.changedAt.epochMilliseconds),
          changedBy: record.changedBy,
        },
      ],
      skipDuplicates: true,
    });
    return created.count === 1;
  }
}
