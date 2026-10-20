import { Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { SpendRepository, SpendTotals } from '../application/ports/spend.repository';

/** A calendar day as the DATE column takes it. */
const dateOf = (day: Temporal.PlainDate): Date => new Date(`${day.toString()}T00:00:00Z`);

/** {@link SpendRepository} on `assistant.spend_days`, scoped by `marketId`. */
export class PrismaSpendRepository implements SpendRepository {
  constructor(private readonly prisma: PrismaService) {}

  async totals(market: MarketContext, day: Temporal.PlainDate): Promise<SpendTotals> {
    const tx = this.prisma.tx(market);
    const rows = await tx.assistantSpendDay.findMany({
      where: {
        marketId: market.marketId,
        day: { gte: dateOf(day.with({ day: 1 })), lte: dateOf(day) },
      },
      select: { day: true, spendMicroUsd: true, conversations: true },
    });
    const today = rows.find((row) => row.day.getTime() === dateOf(day).getTime());
    const last = await tx.assistantSpendDay.findFirst({
      where: { marketId: market.marketId, autoOffAt: { not: null } },
      orderBy: { autoOffAt: 'desc' },
      select: { autoOffAt: true, autoOffCap: true },
    });
    return {
      todayMicroUsd: Number(today?.spendMicroUsd ?? 0n),
      monthMicroUsd: rows.reduce((sum, row) => sum + Number(row.spendMicroUsd), 0),
      conversationsToday: today?.conversations ?? 0,
      lastAutoOff:
        last === null
          ? null
          : {
              at: Temporal.Instant.fromEpochMilliseconds(last.autoOffAt!.getTime()),
              cap: last.autoOffCap === 'monthly' ? 'monthly' : 'daily',
            },
    };
  }

  async add(
    market: MarketContext,
    day: Temporal.PlainDate,
    spend: Parameters<SpendRepository['add']>[2],
  ): Promise<void> {
    await this.prisma.tx(market).assistantSpendDay.upsert({
      where: {
        marketId: market.marketId,
        marketId_day: { marketId: market.marketId, day: dateOf(day) },
      },
      create: {
        marketId: market.marketId,
        tenantId: market.tenantId,
        day: dateOf(day),
        spendMicroUsd: BigInt(spend.microUsd),
        inputTokens: BigInt(spend.inputTokens),
        outputTokens: BigInt(spend.outputTokens),
        conversations: spend.conversations,
      },
      update: {
        spendMicroUsd: { increment: BigInt(spend.microUsd) },
        inputTokens: { increment: BigInt(spend.inputTokens) },
        outputTokens: { increment: BigInt(spend.outputTokens) },
        conversations: { increment: spend.conversations },
      },
    });
  }

  async markAutoOff(
    market: MarketContext,
    day: Temporal.PlainDate,
    cap: 'daily' | 'monthly',
    at: Temporal.Instant,
  ): Promise<boolean> {
    const marked = await this.prisma.tx(market).assistantSpendDay.updateMany({
      where: { marketId: market.marketId, day: dateOf(day), autoOffCap: null },
      data: { autoOffCap: cap, autoOffAt: new Date(at.epochMilliseconds) },
    });
    return marked.count === 1;
  }
}
