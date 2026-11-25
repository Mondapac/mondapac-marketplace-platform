import { discountCostOf, type DiscountCostGroup } from './discount-cost';

const group = (
  kind: DiscountCostGroup['kind'],
  status: DiscountCostGroup['status'],
  rows: number,
  platformShare: bigint,
  sellerShare: bigint,
): DiscountCostGroup => ({
  kind,
  status,
  rows,
  amount: platformShare + sellerShare,
  platformShare,
  sellerShare,
});

describe('discountCostOf', () => {
  it('lists every kind with zeros when nothing was confirmed', () => {
    const zero = { amount: 0n, platformShare: 0n, sellerShare: 0n };
    expect(discountCostOf([])).toEqual({
      kept: { ...zero, orders: 0 },
      byKind: [
        { kind: 'PROMOTION', uses: 0, ...zero },
        { kind: 'FIRST_ORDER', uses: 0, ...zero },
        { kind: 'FREE_SHIPPING', uses: 0, ...zero },
      ],
      released: { ...zero, orders: 0 },
    });
  });

  it('counts the orders by their head rows and keeps the released discounts apart', () => {
    const out = discountCostOf([
      group('ORDER', 'CONFIRMED', 7, 0n, 0n),
      group('ORDER', 'RELEASED', 2, 0n, 0n),
      group('PROMOTION', 'CONFIRMED', 9, 300n, 700n),
      group('FIRST_ORDER', 'CONFIRMED', 3, 1_500n, 0n),
      group('FREE_SHIPPING', 'CONFIRMED', 1, 900n, 0n),
      group('PROMOTION', 'RELEASED', 2, 50n, 150n),
      group('FIRST_ORDER', 'RELEASED', 1, 500n, 0n),
    ]);
    expect(out.kept).toEqual({
      orders: 7,
      amount: 3_400n,
      platformShare: 2_700n,
      sellerShare: 700n,
    });
    expect(out.byKind).toEqual([
      { kind: 'PROMOTION', uses: 9, amount: 1_000n, platformShare: 300n, sellerShare: 700n },
      { kind: 'FIRST_ORDER', uses: 3, amount: 1_500n, platformShare: 1_500n, sellerShare: 0n },
      { kind: 'FREE_SHIPPING', uses: 1, amount: 900n, platformShare: 900n, sellerShare: 0n },
    ]);
    expect(out.released).toEqual({
      orders: 2,
      amount: 700n,
      platformShare: 550n,
      sellerShare: 150n,
    });
  });

  it('refuses a reserved group and an unknown kind (never a guessed cost)', () => {
    expect(() => discountCostOf([group('PROMOTION', 'RESERVED', 1, 1n, 0n)])).toThrow(RangeError);
    expect(() =>
      discountCostOf([{ ...group('PROMOTION', 'CONFIRMED', 1, 1n, 0n), kind: 'GIFT' as never }]),
    ).toThrow(RangeError);
  });
});
