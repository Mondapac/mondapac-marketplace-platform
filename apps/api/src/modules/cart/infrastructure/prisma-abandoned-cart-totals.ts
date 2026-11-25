import type { MarketContext, Money, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { AbandonedCartTotalsReader } from '../application/ports/abandoned-cart-totals';

/**
 * {@link AbandonedCartTotalsReader} on `cart.cart_lines` of the qualifying `cart.carts` (the
 * carts' `(market_id, last_changed_at)` index, then the lines' `(market_id, cart_id, ...)` unique
 * index). One statement reads at most `maxLines + 1` lines, so the cart count and the value come
 * from the same rows; the ids stay in this method.
 */
export class PrismaAbandonedCartTotals implements AbandonedCartTotalsReader {
  constructor(private readonly prisma: PrismaService) {}

  async totals(market: MarketContext, changedAtOrBefore: Temporal.Instant, maxLines: number) {
    const lines = await this.prisma.tx(market).cartLine.findMany({
      where: {
        marketId: market.marketId,
        cart: {
          marketId: market.marketId,
          status: 'active',
          // Not left as a paid order left it (the buyer's next change clears the mark).
          orderedAt: null,
          lastChangedAt: { lte: new Date(changedAtOrBefore.epochMilliseconds) },
        },
      },
      select: { cartId: true, quantity: true, priceAtAddAmount: true, priceAtAddCurrency: true },
      take: maxLines + 1,
    });
    if (lines.length > maxLines) return null;
    const carts = new Set<string>();
    const sums = new Map<string, bigint>();
    for (const line of lines) {
      carts.add(line.cartId);
      const currency = line.priceAtAddCurrency;
      sums.set(
        currency,
        (sums.get(currency) ?? 0n) + line.priceAtAddAmount * BigInt(line.quantity),
      );
    }
    const values: Money[] = [...sums.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([currency, amount]) => ({ amount, currency }));
    return { carts: carts.size, values };
  }
}
