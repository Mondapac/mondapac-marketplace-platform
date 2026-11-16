import { Temporal } from '@mondapac/shared-kernel';
import type { CalculationOutput } from './calculation/types';
import {
  budgetMonthOf,
  kindOfKey,
  limitedUnits,
  sameDiscounts,
  summaryOf,
  type DiscountSummary,
} from './redemption';

const output = (lines: { id: string; promo: string; amount: bigint }[]): CalculationOutput => ({
  currency: 'AUD',
  lines: lines.map((line) => ({
    lineId: line.id,
    gross: 1000n,
    discount: line.amount,
    net: 1000n - line.amount,
    allocations:
      line.amount === 0n
        ? []
        : [
            {
              promotionId: line.promo,
              layer: 'ITEM',
              amount: line.amount,
              sellerShare: line.amount,
              platformShare: 0n,
            },
          ],
  })),
  shipping: [],
  applied: [],
  code: 'NONE',
  totals: {
    goodsGross: 0n,
    goodsDiscount: 0n,
    goodsNet: 0n,
    sellerShare: 0n,
    platformShare: 0n,
    shippingGross: 0n,
    shippingDiscount: 0n,
    shippingNet: 0n,
    payable: 0n,
  },
});

describe('redemption domain', () => {
  it('names the kind of a promotion key', () => {
    expect(kindOfKey('first-order')).toEqual({ kind: 'FIRST_ORDER', promotionId: null });
    expect(kindOfKey('free-shipping:BNE')).toEqual({ kind: 'FREE_SHIPPING', promotionId: null });
    expect(kindOfKey('0199-x')).toEqual({ kind: 'PROMOTION', promotionId: '0199-x' });
  });

  it('takes the budget month in the Market zone, not in UTC', () => {
    // 31 Oct 14:30 UTC is already 1 Nov in Brisbane (UTC+10) and still 31 Oct in New York.
    const at = Temporal.Instant.from('2026-10-31T14:30:00Z');
    expect(budgetMonthOf(at, 'Australia/Brisbane')).toBe('2026-11');
    expect(budgetMonthOf(at, 'America/New_York')).toBe('2026-10');
    expect(budgetMonthOf(Temporal.Instant.from('2026-01-05T00:00:00Z'), 'UTC')).toBe('2026-01');
  });

  it('compares discounts whatever order their parts came in, and only what was discounted', () => {
    const a: DiscountSummary = {
      applied: [
        { promotionId: 'p1', amount: 5n, sellerShare: 5n, platformShare: 0n },
        { promotionId: 'p2', amount: 3n, sellerShare: 0n, platformShare: 3n },
      ],
      lines: [
        { lineId: 'l1', discount: 5n, sellerShare: 5n, platformShare: 0n },
        { lineId: 'l2', discount: 3n, sellerShare: 0n, platformShare: 3n },
      ],
      shipping: [],
    };
    const b: DiscountSummary = {
      applied: [...a.applied].reverse(),
      lines: [...a.lines].reverse(),
      shipping: [],
    };
    expect(sameDiscounts(a, b)).toBe(true);
    expect(
      sameDiscounts(a, { ...b, lines: [{ ...b.lines[0]!, platformShare: 1n }, b.lines[1]!] }),
    ).toBe(false);
    expect(summaryOf(output([{ id: 'l1', promo: 'p', amount: 0n }])).lines).toEqual([]);
  });

  it('counts the units of a limited promotion the way the calculation covers them', () => {
    const lines = [
      { id: 'a', sellerId: 's', productId: 'x', unitPrice: 500n, quantity: 3 },
      { id: 'b', sellerId: 's', productId: 'y', unitPrice: 900n, quantity: 2 },
      { id: 'c', sellerId: 's', productId: 'z', unitPrice: 900n, quantity: 4 },
    ];
    const out = output([
      { id: 'a', promo: 'f', amount: 100n },
      { id: 'b', promo: 'f', amount: 100n },
      { id: 'c', promo: 'other', amount: 100n },
    ]);
    // Dearest first: b (2 units), then a (3 of the 5 left); c is another promotion's.
    expect(limitedUnits(lines, out, 'f', 10)).toBe(5);
    expect(limitedUnits(lines, out, 'f', 4)).toBe(4);
    expect(limitedUnits(lines, out, 'f', 1)).toBe(1);
  });
});
