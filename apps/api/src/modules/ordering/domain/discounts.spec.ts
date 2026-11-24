import { lineCommission } from '../../commission-payouts';
import { ledgerLineAmount, netGoodsOf } from './discounts';

describe('order discounts (promotions package T2)', () => {
  it("takes commission on the line after the seller's share, without the line's own tax", () => {
    const of = (amount: bigint, taxInclusive: boolean, taxBps: number, rateBps: number) =>
      lineCommission({ amount, taxInclusive, taxBps, rateBps }).commission;
    // 2000 inclusive of 10%: base 1818 (half-up), 15% of it is 273 (half-up).
    expect(of(2000n, true, 1000, 1500)).toBe(273n);
    // The seller funds 200: base of 1800 is 1636, 15% is 245. The platform's share never counts.
    expect(of(2000n - 200n, true, 1000, 1500)).toBe(245n);
    // A GST-free line (rate 0) is its own base: 15% of 2000.
    expect(of(2000n, true, 0, 1500)).toBe(300n);
    // A price without tax is its own base (ZZ-like, 12%).
    expect(of(1000n - 100n, false, 1500, 1200)).toBe(108n);
  });

  it('pays the seller the line less only its own share', () => {
    expect(ledgerLineAmount({ lineAmount: 2000n, discountSellerShare: 150n })).toBe(1850n);
  });

  it('spreads the net amount over the units so that all of them give back exactly the net', () => {
    const line = { lineAmount: 3000n, discountAmount: 100n, quantity: 3 };
    // 2900 over 3 units: 966, 967, 967 (floored cumulative shares).
    expect([netGoodsOf(line, 0, 1), netGoodsOf(line, 1, 1), netGoodsOf(line, 2, 1)]).toEqual([
      966n,
      967n,
      967n,
    ]);
    expect(netGoodsOf(line, 0, 3)).toBe(2900n);
    expect(netGoodsOf(line, 1, 2)).toBe(1934n);
    expect(netGoodsOf({ lineAmount: 500n, discountAmount: 0n, quantity: 2 }, 0, 1)).toBe(250n);
  });

  it('gives back exactly the net for every split of a line, whatever its size and discount', () => {
    for (const quantity of [1, 2, 3, 7]) {
      for (const [lineAmount, discountAmount] of [
        [1000n, 0n],
        [1001n, 13n],
        [999n, 998n],
        [700n, 700n],
      ] as const) {
        const line = { lineAmount, discountAmount, quantity };
        const net = lineAmount - discountAmount;
        const perUnit = Array.from({ length: quantity }, (_, n) => netGoodsOf(line, n, 1));
        expect(perUnit.reduce((sum, unit) => sum + unit, 0n)).toBe(net);
        expect(perUnit.every((unit) => unit >= 0n)).toBe(true);
        // Any two-part split adds up too: what one refund leaves, the next gives back.
        for (let first = 0; first <= quantity; first += 1) {
          expect(netGoodsOf(line, 0, first) + netGoodsOf(line, first, quantity - first)).toBe(net);
        }
      }
    }
    // A line discounted to nothing gives nothing back.
    expect(netGoodsOf({ lineAmount: 700n, discountAmount: 700n, quantity: 7 }, 0, 7)).toBe(0n);
  });
});
