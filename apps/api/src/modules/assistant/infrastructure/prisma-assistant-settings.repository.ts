import { Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  AssistantSettingsRecord,
  AssistantSettingsRepository,
} from '../application/ports/assistant-settings.repository';
import {
  AUDIENCES,
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

/**
 * The value written to the retired `model_tier` column (NOT NULL, CHECK fast or balanced) until a
 * migration drops it (FE-20261125-ai-gateway-drop-assistant-model-tier). Never read: the chat's
 * models are the Market's list for the chat task type (AI Gateway G4d1).
 */
const RETIRED_MODEL_TIER = 'fast';

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
      users: stored(USER_GROUPS, row.users),
      guestMessageLimit: row.guestMessageLimit,
      customerMessageLimit: row.customerMessageLimit,
      retention: stored(RETENTIONS, row.retention),
      replyLanguage: stored(REPLY_LANGUAGES, row.replyLanguage),
      dailySpendCapUsdCents: row.dailySpendCapUsdCents,
      monthlySpendCapUsdCents: row.monthlySpendCapUsdCents,
      supportHandoff: stored(SUPPORT_HANDOFFS, row.supportHandoff),
      basketProposals: row.basketProposals,
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
          modelTier: RETIRED_MODEL_TIER,
          changedAt: new Date(record.changedAt.epochMilliseconds),
          changedBy: record.changedBy,
        },
      ],
      skipDuplicates: true,
    });
    return created.count === 1;
  }
}
