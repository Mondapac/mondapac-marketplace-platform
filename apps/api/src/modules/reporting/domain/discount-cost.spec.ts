import { discountCostOf, sharesBp, type DiscountTotals } from './discount-cost';

const totals = (
  orders: number,
  kinds: { promotion?: [bigint, bigint]; firstOrder?: bigint; freeShipping?: bigint },
  released: { orders: number; amount: bigint } = { orders: 0, amount: 0n },
  uses: { firstOrder?: number; freeShipping?: number } = {},
): DiscountTotals => {
  const [promoPlatform, promoSeller] = kinds.promotion ?? [0n, 0n];
  const first = kinds.firstOrder ?? 0n;
  const ship = kinds.freeShipping ?? 0n;
  const platformShare = promoPlatform + first + ship;
  return {
    kept: {
      orders,
      amount: platformShare + promoSeller,
      platformShare,
      sellerShare: promoSeller,
    },
    byKind: [
      {
        kind: 'promotion',
        uses: orders,
        amount: promoPlatform + promoSeller,
        platformShare: promoPlatform,
        sellerShare: promoSeller,
      },
      {
        kind: 'first-order',
        uses: uses.firstOrder ?? 1,
        amount: first,
        platformShare: first,
        sellerShare: 0n,
      },
      {
        kind: 'free-shipping',
        uses: uses.freeShipping ?? 0,
        amount: ship,
        platformShare: ship,
        sellerShare: 0n,
      },
    ],
    released: {
      orders: released.orders,
      amount: released.amount,
      platformShare: released.amount,
      sellerShare: 0n,
    },
  };
};

describe('discountCostOf', () => {
  it('holds the amounts back below five discounted orders', () => {
    expect(discountCostOf(totals(4, { firstOrder: 2_000n }), totals(0, {}))).toEqual({
      status: 'not-enough-data',
      orders: 4,
      minimum: 5,
    });
  });

  it('answers the shares, the kinds and the change against the period before', () => {
    const out = discountCostOf(
      totals(
        5,
        { promotion: [2_000n, 6_000n], firstOrder: 2_000n },
        { orders: 5, amount: 500n },
        { firstOrder: 5 },
      ),
      totals(9, { promotion: [1_000n, 9_000n] }),
    );
    expect(out).toEqual({
      status: 'available',
      orders: 5,
      amount: 10_000n,
      platformShare: 4_000n,
      sellerShare: 6_000n,
      platformShareBp: 4000,
      change: { value: 0, direction: 'flat', state: 'ok' },
      previousAmount: 10_000n,
      byKind: [
        { kind: 'promotion', uses: 5, amount: 8_000n, platformShare: 2_000n, shareBp: 8000 },
        { kind: 'first-order', uses: 5, amount: 2_000n, platformShare: 2_000n, shareBp: 2000 },
        { kind: 'free-shipping', uses: 0, amount: 0n, platformShare: 0n, shareBp: 0 },
      ],
      released: { orders: 5, amount: 500n },
    });
  });

  it('holds back a kind of 1 to 4 uses and a released of 1 to 4 orders, alone', () => {
    const out = discountCostOf(
      totals(
        6,
        { promotion: [2_000n, 6_000n], firstOrder: 2_000n },
        { orders: 4, amount: 500n },
        { firstOrder: 4 },
      ),
      totals(9, { promotion: [1_000n, 9_000n] }),
    );
    if (out.status !== 'available') throw new Error('expected available');
    expect(out.amount).toBe(10_000n);
    expect(out.byKind).toEqual([
      { kind: 'promotion', uses: 6, amount: 8_000n, platformShare: 2_000n, shareBp: 8000 },
      { kind: 'first-order', uses: null, amount: null, platformShare: null, shareBp: null },
      { kind: 'free-shipping', uses: 0, amount: 0n, platformShare: 0n, shareBp: 0 },
    ]);
    expect(out.released).toBeNull();
  });

  it('reads the change as ok at exactly 100.00 before and n/a at 0 before', () => {
    const at = discountCostOf(
      totals(6, { firstOrder: 5_000n }),
      totals(6, { firstOrder: 10_000n }),
    );
    expect(at.status === 'available' && at.change).toEqual({
      value: -5000,
      direction: 'down',
      state: 'ok',
    });
    const zero = discountCostOf(totals(6, { firstOrder: 5_000n }), totals(0, {}));
    expect(zero.status === 'available' && zero.change.state).toBe('na');
  });

  it('reads the change as n/a below 100.00 of the currency before, and a zero cost has no shares', () => {
    const out = discountCostOf(totals(6, {}), totals(6, { firstOrder: 9_999n }));
    if (out.status !== 'available') throw new Error('expected available');
    expect(out.change.state).toBe('na');
    expect(out.platformShareBp).toBeNull();
    expect(out.byKind.every((row) => row.shareBp === null)).toBe(true);
  });

  it('refuses totals whose shares or kinds do not add up', () => {
    const good = totals(5, { promotion: [100n, 100n] });
    expect(() =>
      discountCostOf({ ...good, kept: { ...good.kept, sellerShare: 99n } }, good),
    ).toThrow(RangeError);
    expect(() => discountCostOf({ ...good, byKind: good.byKind.slice(1) }, good)).toThrow(
      RangeError,
    );
    expect(() =>
      discountCostOf(good, { ...good, released: { ...good.released, orders: -1 } }),
    ).toThrow(RangeError);
  });
});

describe('sharesBp', () => {
  it('gives thirds 3334, 3333, 3333: the left point to the earlier entry on a tie', () => {
    expect(sharesBp([1n, 1n, 1n], 3n)).toEqual([3334, 3333, 3333]);
  });

  it('always adds up to 10000, the left points to the largest remainders', () => {
    const shares = sharesBp([1n, 2n, 4n], 7n);
    expect(shares).toEqual([1429, 2857, 5714]);
    expect(shares.reduce((sum, value) => sum! + value!, 0)).toBe(10_000);
  });

  it('is null for every entry when the whole is zero', () => {
    expect(sharesBp([0n, 0n], 0n)).toEqual([null, null]);
  });
});
