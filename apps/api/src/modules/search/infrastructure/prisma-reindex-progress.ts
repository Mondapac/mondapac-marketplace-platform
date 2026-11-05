import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { ReindexProgress, ReindexState } from '../application/ports/reindex';

const toDate = (instant: Temporal.Instant): Date => new Date(instant.epochMilliseconds);

/** {@link ReindexProgress} over the one `search.reindex_state` row of the Market. */
export class PrismaReindexProgress implements ReindexProgress {
  constructor(private readonly prisma: PrismaService) {}

  async read(market: MarketContext): Promise<ReindexState | null> {
    const row = await this.prisma.tx(market).searchReindexState.findFirst({
      where: { marketId: market.marketId },
    });
    if (row === null) return null;
    return {
      doneStamp: row.doneStamp,
      targetStamp: row.targetStamp,
      status: row.status as ReindexState['status'],
      offersDone: row.offersDone,
      cursorOfferId: row.cursorOfferId as Id<'Offer'> | null,
    };
  }

  async begin(market: MarketContext, targetStamp: string, now: Temporal.Instant): Promise<void> {
    const at = toDate(now);
    const data = {
      targetStamp,
      status: 'running',
      offersDone: 0,
      cursorOfferId: null,
      startedAt: at,
      updatedAt: at,
      finishedAt: null,
      failure: null,
    };
    // The market guard takes no upsert by a lone id: update the Market's row, else create it.
    const tx = this.prisma.tx(market);
    const updated = await tx.searchReindexState.updateMany({
      where: { marketId: market.marketId },
      data,
    });
    if (updated.count === 0) {
      await tx.searchReindexState.create({
        data: { marketId: market.marketId, tenantId: market.tenantId, ...data },
      });
    }
  }

  async advance(
    market: MarketContext,
    offersDone: number,
    cursor: Id<'Offer'>,
    now: Temporal.Instant,
  ): Promise<void> {
    await this.prisma.tx(market).searchReindexState.updateMany({
      where: { marketId: market.marketId },
      data: { status: 'running', offersDone, cursorOfferId: cursor, updatedAt: toDate(now) },
    });
  }

  async finish(market: MarketContext, stamp: string, now: Temporal.Instant): Promise<void> {
    const at = toDate(now);
    await this.prisma.tx(market).searchReindexState.updateMany({
      where: { marketId: market.marketId },
      data: {
        doneStamp: stamp,
        targetStamp: stamp,
        status: 'idle',
        cursorOfferId: null,
        finishedAt: at,
        updatedAt: at,
        failure: null,
      },
    });
  }

  async fail(market: MarketContext, code: string, now: Temporal.Instant): Promise<void> {
    await this.prisma.tx(market).searchReindexState.updateMany({
      where: { marketId: market.marketId },
      data: { status: 'failed', failure: code.slice(0, 200), updatedAt: toDate(now) },
    });
  }
}
