import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, MarketContext } from '@mondapac/shared-kernel';
import type { CapabilityUsageReport } from '../../../platform/ai/usage/ai-usage-report';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { BUYER_CHAT } from '../contracts/ai-capabilities';
import type { SpendRepository, SpendTotals } from '../application/ports/spend.repository';

/** A calendar day as the DATE column takes it. */
const dateOf = (day: Temporal.PlainDate): Date => new Date(`${day.toString()}T00:00:00Z`);

/**
 * {@link SpendRepository} on the AI Gateway (AI Gateway G7, step 3 of 4; docs/design/domain/
 * platform-ai.md section 10). The spend is the gateway's: every model call is settled in the
 * gateway's usage record before `complete` answers, so the buyer chat's settled cost per Market day
 * is read through {@link CapabilityUsageReport} and the spend fields given to `add` are not written
 * again (the gateway counted them). The conversation count is the assistant's own
 * (`assistant.conversation_days`); the auto-off record is the gateway's once-a-day "cap reached"
 * record of the buyer chat. `assistant.spend_days` is no longer written or read; step 4 drops it
 * (FE-20261125-ai-gateway-drop-spend-days).
 */
export class PrismaSpendRepository implements SpendRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usage: CapabilityUsageReport,
  ) {}

  async totals(market: MarketContext, day: Temporal.PlainDate): Promise<SpendTotals> {
    const costs = await this.usage.costByDay(market, BUYER_CHAT, day.with({ day: 1 }), day);
    const today = costs.find((row) => Temporal.PlainDate.compare(row.day, day) === 0);
    const counted = await this.prisma.tx(market).assistantConversationDay.findUnique({
      where: {
        marketId: market.marketId,
        marketId_day: { marketId: market.marketId, day: dateOf(day) },
      },
      select: { conversations: true },
    });
    const last = await this.usage.lastCapReached(market, BUYER_CHAT);
    return {
      todayMicroUsd: today?.costMicroUsd ?? 0,
      monthMicroUsd: costs.reduce((sum, row) => sum + row.costMicroUsd, 0),
      conversationsToday: counted?.conversations ?? 0,
      lastAutoOff:
        last === null ? null : { at: last.at, cap: last.period === 'month' ? 'monthly' : 'daily' },
    };
  }

  async add(
    market: MarketContext,
    day: Temporal.PlainDate,
    spend: Parameters<SpendRepository['add']>[2],
  ): Promise<void> {
    // The spend fields are what the gateway settled already; only the conversations are counted.
    if (spend.conversations <= 0) return;
    await this.prisma.tx(market).assistantConversationDay.upsert({
      where: {
        marketId: market.marketId,
        marketId_day: { marketId: market.marketId, day: dateOf(day) },
      },
      create: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        day: dateOf(day),
        conversations: spend.conversations,
      },
      update: { conversations: { increment: spend.conversations } },
    });
  }

  async capReached(context: CallContext): Promise<'daily' | 'monthly' | null> {
    const period = await this.usage.capReached(context, BUYER_CHAT);
    return period === null ? null : period === 'month' ? 'monthly' : 'daily';
  }

  markAutoOff(
    market: MarketContext,
    day: Temporal.PlainDate,
    cap: 'daily' | 'monthly',
    at: Temporal.Instant,
  ): Promise<boolean> {
    return this.usage.markCapReached(
      market,
      BUYER_CHAT,
      day,
      cap === 'monthly' ? 'month' : 'day',
      at,
    );
  }
}
