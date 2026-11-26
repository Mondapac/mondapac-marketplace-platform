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

/**
 * The values the retired spend cap columns (NOT NULL, CHECK 100 to 100 000 and 100 to 2 000 000
 * cents, day not above month) get on a Market's first row since AI Gateway G4d2: the former
 * defaults. A later row carries the previous row's values forward, so a release before G4d2 that
 * is rolled back to finds the caps it had. Never read: the chat's caps are the gateway's settings
 * `ai-cap-buyer-chat-day` and `-month` (FE-20261126-ai-gateway-drop-assistant-cap-columns drops
 * the columns).
 */
const RETIRED_CAPS = { dailySpendCapUsdCents: 1_000, monthlySpendCapUsdCents: 20_000 } as const;

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
    const tx = this.prisma.tx(market);
    const previous = await tx.assistantSettings.findFirst({
      where: { marketId: market.marketId },
      orderBy: { version: 'desc' },
      select: { dailySpendCapUsdCents: true, monthlySpendCapUsdCents: true },
    });
    const created = await tx.assistantSettings.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          version: record.version,
          ...record.settings,
          modelTier: RETIRED_MODEL_TIER,
          ...(previous ?? RETIRED_CAPS),
          changedAt: new Date(record.changedAt.epochMilliseconds),
          changedBy: record.changedBy,
        },
      ],
      skipDuplicates: true,
    });
    return created.count === 1;
  }
}
