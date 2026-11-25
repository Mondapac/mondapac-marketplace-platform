import type { MarketContext, Money, Temporal } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { AbandonedCartTotalsReader } from '../application/ports/abandoned-cart-totals';

/**
 * {@link AbandonedCartTotalsReader} on `cart.carts` and `cart.cart_lines`, in the caller's Market
 * and tenant at both levels, with two aggregate statements and no row brought into memory: the
 * lines grouped by currency and quantity with their prices summed (the value is the sum of
 * quantity × that sum; a line holds 1 to 999 units, so the groups stay few), and a count of the
 * carts that have a line. The carts are found by their `(market_id, last_changed_at)` index and
 * their lines through the lines' `(market_id, cart_id, offer_id, variant_id)` unique index. The two
 * statements run in the caller's read-only unit, which opens no transaction (ADR-0025), so a cart
 * changed between them can make the count and the value differ by that cart: approximate anyway.
 */
export class PrismaAbandonedCartTotals implements AbandonedCartTotalsReader {
  constructor(private readonly prisma: PrismaService) {}

  async totals(market: MarketContext, changedAtOrBefore: Temporal.Instant) {
    const tx = this.prisma.tx(market);
    const abandoned = {
      marketId: market.marketId,
      tenantId: market.tenantId,
      status: 'active',
      // Not left as a paid order left it (the buyer's next change clears the mark).
      orderedAt: null,
      lastChangedAt: { lte: new Date(changedAtOrBefore.epochMilliseconds) },
    };
    const [groups, carts] = await Promise.all([
      tx.cartLine.groupBy({
        by: ['priceAtAddCurrency', 'quantity'],
        where: { marketId: market.marketId, tenantId: market.tenantId, cart: abandoned },
        _sum: { priceAtAddAmount: true },
      }),
      tx.cartCart.count({ where: { ...abandoned, lines: { some: {} } } }),
    ]);
    const sums = new Map<string, bigint>();
    for (const group of groups) {
      const currency = group.priceAtAddCurrency;
      const amount = (group._sum.priceAtAddAmount ?? 0n) * BigInt(group.quantity);
      sums.set(currency, (sums.get(currency) ?? 0n) + amount);
    }
    const values: Money[] = [...sums.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([currency, amount]) => ({ amount, currency }));
    return { carts, values };
  }
}
