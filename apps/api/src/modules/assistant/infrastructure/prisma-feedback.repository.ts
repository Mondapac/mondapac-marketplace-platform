import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { FeedbackRepository } from '../application/ports/feedback.repository';
import type { Feedback } from '../domain/feedback';

const dateOf = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

/** {@link FeedbackRepository} on `assistant.feedback`, scoped by `marketId`. */
export class PrismaFeedbackRepository implements FeedbackRepository {
  constructor(private readonly prisma: PrismaService) {}

  async save(
    market: MarketContext,
    conversationId: string,
    position: number,
    feedback: Feedback,
    at: Temporal.Instant,
  ): Promise<boolean> {
    const tx = this.prisma.tx(market);
    const message = await tx.assistantMessage.findFirst({
      where: { marketId: market.marketId, conversationId, position, role: 'assistant' },
      select: { position: true },
    });
    if (message === null) return false;
    // The last write wins: change the row if there is one, else create it; a request that
    // creates it between the two steps makes this one change it instead.
    const key = { marketId: market.marketId, conversationId, position };
    const change = { rating: feedback.rating, reason: feedback.reason, updatedAt: dateOf(at) };
    for (let attempt = 0; attempt < 2; attempt++) {
      const changed = await tx.assistantFeedback.updateMany({ where: key, data: change });
      if (changed.count === 1) return true;
      const created = await tx.assistantFeedback.createMany({
        data: [{ ...key, tenantId: market.tenantId, ...change, createdAt: dateOf(at) }],
        skipDuplicates: true,
      });
      if (created.count === 1) return true;
    }
    return false;
  }
}
