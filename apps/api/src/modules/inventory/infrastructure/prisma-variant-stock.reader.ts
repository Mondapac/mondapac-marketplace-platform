import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  OutOfStockVariantPage,
  VariantStockReader,
} from '../application/ports/variant-stock.reader';

/** Candidate Variants examined per round trip. */
const BATCH = 500;

/**
 * {@link VariantStockReader} on `inventory.availability_signals` and `inventory.stock_items`;
 * every statement carries `marketId`. Plain model reads, no raw SQL: a batch of Variants that have
 * an `out` signal is checked against the Variants with a signal that is not `out` and those with
 * a live stock item, then the walk continues after the last candidate.
 */
export class PrismaVariantStockReader implements VariantStockReader {
  constructor(private readonly prisma: PrismaService) {}

  async listOutOfStockEverywhere(
    market: MarketContext,
    page: OutOfStockVariantPage,
  ): Promise<readonly Id<'Variant'>[]> {
    const found: Id<'Variant'>[] = [];
    let after: string | null = page.after;
    while (found.length < page.limit) {
      const batch = await this.#batch(market, after, BATCH);
      if (batch.candidates.length === 0) break;
      for (const id of batch.matching) {
        if (found.length < page.limit) found.push(id);
      }
      after = batch.candidates[batch.candidates.length - 1]!;
      if (batch.candidates.length < BATCH) break;
    }
    return found;
  }

  async countOutOfStockEverywhere(market: MarketContext): Promise<number> {
    let total = 0;
    let after: string | null = null;
    for (;;) {
      const batch = await this.#batch(market, after, BATCH);
      total += batch.matching.length;
      if (batch.candidates.length < BATCH) return total;
      after = batch.candidates[batch.candidates.length - 1]!;
    }
  }

  async #batch(
    market: MarketContext,
    after: string | null,
    take: number,
  ): Promise<{ candidates: string[]; matching: Id<'Variant'>[] }> {
    const tx = this.prisma.tx(market);
    const out = await tx.inventoryAvailabilitySignal.findMany({
      where: {
        marketId: market.marketId,
        status: 'out',
        ...(after === null ? {} : { variantId: { gt: after } }),
      },
      distinct: ['variantId'],
      select: { variantId: true },
      orderBy: { variantId: 'asc' },
      take,
    });
    const candidates = out.map((row) => row.variantId);
    if (candidates.length === 0) return { candidates, matching: [] };
    const [available, live] = await Promise.all([
      tx.inventoryAvailabilitySignal.findMany({
        where: {
          marketId: market.marketId,
          variantId: { in: candidates },
          status: { not: 'out' },
        },
        distinct: ['variantId'],
        select: { variantId: true },
      }),
      tx.inventoryStockItem.findMany({
        where: { marketId: market.marketId, variantId: { in: candidates }, retiredAt: null },
        distinct: ['variantId'],
        select: { variantId: true },
      }),
    ]);
    const blocked = new Set(available.map((row) => row.variantId));
    const sold = new Set(live.map((row) => row.variantId));
    return {
      candidates,
      matching: candidates.filter((id) => !blocked.has(id) && sold.has(id)) as Id<'Variant'>[],
    };
  }
}
