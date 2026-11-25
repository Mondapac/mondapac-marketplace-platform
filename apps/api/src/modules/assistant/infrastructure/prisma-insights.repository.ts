import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { CapabilityUsageReport } from '../../../platform/ai/usage/ai-usage-report';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import { fieldLabel } from '../../../platform/subject-keys/labels';
import type { SubjectKeyService } from '../../../platform/subject-keys/subject-key-service';
import type {
  DayInsight,
  FeedbackInsight,
  InsightsRepository,
} from '../application/ports/insights.repository';
import type { UnansweredCandidate, UnansweredReason } from '../domain/insights';
import { BUYER_CHAT } from '../contracts/ai-capabilities';

const MESSAGE_TEXT = fieldLabel('assistant.message.text');
/** Buyer messages read per query (the OR of (conversation, position) pairs). */
const BUYER_CHUNK = 200;

const instantOf = (date: Date): Temporal.Instant =>
  Temporal.Instant.fromEpochMilliseconds(date.getTime());
const dateOf = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

/**
 * {@link InsightsRepository}: read-only aggregates over `assistant.conversation_days`, the AI
 * Gateway's settled cost of the buyer chat (G7, through {@link CapabilityUsageReport}),
 * `assistant.messages` and `assistant.feedback`, scoped by `marketId`. Buyer text is decrypted
 * here, one conversation key at a time; it was masked before it was stored.
 */
export class PrismaInsightsRepository implements InsightsRepository {
  readonly #logger = new Logger('PrismaInsightsRepository');

  constructor(
    private readonly prisma: PrismaService,
    private readonly keys: SubjectKeyService,
    private readonly usage: CapabilityUsageReport,
  ) {}

  async days(
    market: MarketContext,
    from: Temporal.PlainDate,
    to: Temporal.PlainDate,
  ): Promise<readonly DayInsight[]> {
    const rows = await this.prisma.tx(market).assistantConversationDay.findMany({
      where: {
        marketId: market.marketId,
        day: {
          gte: new Date(`${from.toString()}T00:00:00Z`),
          lte: new Date(`${to.toString()}T00:00:00Z`),
        },
      },
      select: { day: true, conversations: true },
    });
    const costs = await this.usage.costByDay(market, BUYER_CHAT, from, to);
    // A day with a conversation or a cost: the two never disagree on which Market day it is.
    const byDay = new Map<string, { conversations: number; spendMicroUsd: number }>();
    for (const row of rows) {
      const key = row.day.toISOString().slice(0, 10);
      byDay.set(key, { conversations: row.conversations, spendMicroUsd: 0 });
    }
    for (const cost of costs) {
      const key = cost.day.toString();
      const day = byDay.get(key) ?? { conversations: 0, spendMicroUsd: 0 };
      byDay.set(key, { ...day, spendMicroUsd: cost.costMicroUsd });
    }
    return [...byDay]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, totals]) => ({ day: Temporal.PlainDate.from(day), ...totals }));
  }

  async feedback(
    market: MarketContext,
    from: Temporal.Instant,
    to: Temporal.Instant,
  ): Promise<FeedbackInsight> {
    const groups = await this.prisma.tx(market).assistantFeedback.groupBy({
      by: ['rating', 'reason'],
      where: {
        marketId: market.marketId,
        message: { createdAt: { gte: dateOf(from), lt: dateOf(to) } },
      },
      _count: { _all: true },
    });
    const total = { up: 0, down: 0, reasons: { wrong: 0, 'not-found': 0, other: 0 } };
    for (const group of groups) {
      const count = group._count._all;
      if (group.rating === 'up') total.up += count;
      else {
        total.down += count;
        if (group.reason === 'wrong' || group.reason === 'not-found' || group.reason === 'other') {
          total.reasons[group.reason] += count;
        }
      }
    }
    return total;
  }

  handoffs(market: MarketContext, from: Temporal.Instant, to: Temporal.Instant): Promise<number> {
    return this.prisma.tx(market).assistantMessage.count({
      where: {
        marketId: market.marketId,
        role: 'assistant',
        createdAt: { gte: dateOf(from), lt: dateOf(to) },
        cards: { has: 'support' },
      },
    });
  }

  async unanswered(
    market: MarketContext,
    from: Temporal.Instant,
    to: Temporal.Instant,
    limit: number,
  ): Promise<readonly UnansweredCandidate[]> {
    const tx = this.prisma.tx(market);
    const window = { gte: dateOf(from), lt: dateOf(to) };
    const turn = {
      conversationId: true,
      position: true,
      createdAt: true,
      notices: true,
      emptySearch: true,
    } as const;
    // Two reads, each served by its own index (one OR over a relation cannot use the partial
    // index): the replies flagged by the server, and the replies a buyer rated down.
    const marked = await tx.assistantMessage.findMany({
      where: {
        marketId: market.marketId,
        role: 'assistant',
        createdAt: window,
        OR: [{ notices: { hasSome: ['unavailable', 'tool-failed'] } }, { emptySearch: true }],
      },
      orderBy: [{ createdAt: 'desc' }, { position: 'desc' }],
      take: limit,
      select: { ...turn, feedback: { select: { rating: true } } },
    });
    const rated = await tx.assistantFeedback.findMany({
      where: { marketId: market.marketId, rating: 'down', message: { createdAt: window } },
      orderBy: [{ message: { createdAt: 'desc' } }, { position: 'desc' }],
      take: limit,
      select: { message: { select: turn } },
    });
    const merged = new Map<string, (typeof marked)[number]>();
    for (const row of marked) merged.set(`${row.conversationId}:${row.position}`, row);
    for (const { message } of rated) {
      merged.set(`${message.conversationId}:${message.position}`, {
        ...message,
        feedback: { rating: 'down' },
      });
    }
    const flagged = [...merged.values()]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.position - a.position)
      .slice(0, limit);
    // The buyer's line is the message just before the reply.
    const asked = new Map<string, string>();
    for (let start = 0; start < flagged.length; start += BUYER_CHUNK) {
      const chunk = flagged.slice(start, start + BUYER_CHUNK);
      const rows = await tx.assistantMessage.findMany({
        where: {
          marketId: market.marketId,
          role: 'buyer',
          OR: chunk.map((row) => ({
            conversationId: row.conversationId,
            position: row.position - 1,
          })),
        },
        select: { conversationId: true, position: true, textCipher: true },
      });
      for (const row of rows) {
        try {
          const text = await this.keys.decrypt(
            market,
            row.conversationId as Id<'Conversation'>,
            MESSAGE_TEXT,
            row.textCipher,
          );
          // A destroyed key is a purged conversation: nothing to show.
          if (text.ok) asked.set(`${row.conversationId}:${row.position}`, text.value);
        } catch {
          // One unreadable row must not take the whole read down; it is left out of the list.
          this.#logger.warn({
            msg: 'assistant.insights.unreadable-message',
            marketId: market.marketId,
          });
        }
      }
    }
    const candidates: UnansweredCandidate[] = [];
    for (const row of flagged) {
      const text = asked.get(`${row.conversationId}:${row.position - 1}`);
      if (text === undefined) continue;
      const reasons: UnansweredReason[] = [];
      if (row.notices.includes('unavailable')) reasons.push('unavailable');
      if (row.notices.includes('tool-failed')) reasons.push('tool-failed');
      if (row.emptySearch) reasons.push('no-results');
      if (row.feedback?.rating === 'down') reasons.push('thumbs-down');
      candidates.push({ text, at: instantOf(row.createdAt), reasons });
    }
    return candidates;
  }
}
