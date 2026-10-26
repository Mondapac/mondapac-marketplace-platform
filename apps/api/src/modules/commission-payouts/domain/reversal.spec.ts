import { testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { ConfigCommissionPolicy } from '../infrastructure/config-commission-policy';
import { commissionBase, commissionOn } from './commission';
import { reversalDelta, reversedAmount, reverseLine, reverseShipping } from './reversal';

// The arithmetic of refund reversals on both Market fixtures (AU: AUD, prices with GST 10 %;
// ZZ: JPY, prices without tax). Every amount comes from the stored ledger rows, so refunding all
// units over any sequence of partial refunds reverses exactly the original rows.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

/** A small deterministic generator (mulberry32), so a failing case can be replayed from its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const between = (next: () => number, low: number, high: number): number =>
  low + Math.floor(next() * (high - low + 1));

/** Splits `total` into consecutive non-empty parts, at random. */
function split(next: () => number, total: number): number[] {
  const parts: number[] = [];
  let left = total;
  while (left > 0) {
    const part = between(next, 1, left);
    parts.push(part);
    left -= part;
  }
  return parts;
}

describe('reversedAmount and reversalDelta', () => {
  it('reverses nothing for no units and the whole row for all of them', () => {
    expect(reversedAmount(1100n, 0n, 3n)).toBe(0n);
    expect(reversedAmount(1100n, 3n, 3n)).toBe(1100n);
    expect(reversedAmount(0n, 2n, 3n)).toBe(0n);
  });

  it('rounds half up on the cumulative amount, not on each part', () => {
    // 1000 over 3 units: 333.33, 666.67, 1000 -> 333, 667, 1000; the parts 333, 334, 333.
    expect(reversedAmount(1000n, 1n, 3n)).toBe(333n);
    expect(reversedAmount(1000n, 2n, 3n)).toBe(667n);
    expect([0n, 1n, 2n].map((before) => reversalDelta(1000n, before, before + 1n, 3n))).toEqual([
      333n,
      334n,
      333n,
    ]);
    // Exactly half rounds up: 5 over 2 units, one unit -> 2.5 -> 3.
    expect(reversedAmount(5n, 1n, 2n)).toBe(3n);
  });

  it('refuses arguments that are not a share of a row', () => {
    expect(() => reversedAmount(-1n, 1n, 2n)).toThrow(RangeError);
    expect(() => reversedAmount(10n, 3n, 2n)).toThrow(RangeError);
    expect(() => reversedAmount(10n, 0n, 0n)).toThrow(RangeError);
    expect(() => reversalDelta(10n, 2n, 1n, 3n)).toThrow(RangeError);
  });
});

describe('reverseLine', () => {
  it('reverses a worked AU line: 3 units of $11.00 with GST, commission 15 % of $30.00 ex GST', () => {
    const rows = { sale: 3300n, commission: 450n, commissionBase: 3000n };
    expect(reverseLine(rows, 0, 1, 3)).toEqual({ sale: 1100n, commission: 150n, base: 1000n });
    expect(reverseLine(rows, 1, 2, 3)).toEqual({ sale: 2200n, commission: 300n, base: 2000n });
    expect(reverseLine(rows, 0, 3, 3)).toEqual({ sale: 3300n, commission: 450n, base: 3000n });
  });

  it('keeps the commission under its base even where rounding would not', () => {
    // One cent of commission against a base of 6 over 12 units: 5 -> 6 units moves the commission
    // by 1 and the plain base by 0; the base is raised to the commission.
    const rows = { sale: 12n, commission: 1n, commissionBase: 6n };
    expect(reversedAmount(1n, 6n, 12n) - reversedAmount(1n, 5n, 12n)).toBe(1n);
    expect(reversedAmount(6n, 6n, 12n) - reversedAmount(6n, 5n, 12n)).toBe(0n);
    const step = reverseLine(rows, 5, 1, 12);
    expect(step.commission).toBe(1n);
    expect(step.base).toBe(1n);
  });
});

describe.each([['AU'], ['ZZ']] as const)('reversal sums in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const config = markets.get(market.marketId);
  const settings = new ConfigCommissionPolicy(markets).settings(market)!;
  const inclusive = config.pricesIncludeTax;
  const rateBps = settings.defaultRateBps;

  it('reads the Market fixture the case is meant for', () => {
    expect(settings.currency).toBe(code === 'AU' ? 'AUD' : 'JPY');
    expect(inclusive).toBe(code === 'AU');
  });

  it('reverses every line exactly over any sequence of partial refunds (random cases)', () => {
    const next = random(code === 'AU' ? 20261025 : 20261026);
    for (let run = 0; run < 400; run += 1) {
      const quantity = between(next, 1, 40);
      const unit = BigInt(between(next, 1, code === 'AU' ? 25_000 : 900_000));
      const sale = unit * BigInt(quantity);
      // The rows as the paid flow writes them (ledger-flow.ts recordSellerOrderPaid).
      const base = commissionBase(sale, inclusive, settings.provisionalTaxRateBps);
      const commission = commissionOn(base, rateBps);
      const rows = { sale, commission, commissionBase: base };

      let units = 0;
      const total = { sale: 0n, commission: 0n, base: 0n };
      for (const part of split(next, quantity)) {
        const step = reverseLine(rows, units, part, quantity);
        expect(step.sale).toBeGreaterThanOrEqual(0n);
        expect(step.commission).toBeGreaterThanOrEqual(0n);
        // The database refuses a commission above its base.
        expect(step.commission).toBeLessThanOrEqual(step.base);
        total.sale += step.sale;
        total.commission += step.commission;
        total.base += step.base;
        units += part;
      }
      expect(units).toBe(quantity);
      expect(total.sale).toBe(sale);
      expect(total.commission).toBe(commission);
      // The base sums to the original unless a tiny line forced a step up (never below it).
      expect(total.base).toBeGreaterThanOrEqual(base);
    }
  });

  it('reverses the shipping row exactly over any sequence of partial amounts (random cases)', () => {
    const next = random(code === 'AU' ? 7 : 8);
    for (let run = 0; run < 400; run += 1) {
      const row = BigInt(between(next, 1, 5_000_000));
      // The charge is the row plus its tax when the fee excludes tax (ZZ), the row itself when the
      // tax is inside (AU): the whole charge reverses the whole row either way.
      const tax = inclusive ? 0n : (row * 1500n + 5000n) / 10000n;
      const charge = row + tax;
      let done = 0n;
      let reversed = 0n;
      while (done < charge) {
        const part = BigInt(between(next, 1, Number(charge - done)));
        const step = reverseShipping(row, done, done + part, charge);
        expect(step).toBeGreaterThanOrEqual(0n);
        reversed += step;
        done += part;
      }
      expect(reversed).toBe(row);
    }
  });

  it('gives the same total whatever the order the refunds are posted in', () => {
    const next = random(code === 'AU' ? 99 : 100);
    for (let run = 0; run < 100; run += 1) {
      const quantity = between(next, 2, 12);
      const sale = BigInt(between(next, quantity, 90_000));
      const base = commissionBase(sale, inclusive, settings.provisionalTaxRateBps);
      const rows = { sale, commission: commissionOn(base, rateBps), commissionBase: base };
      const parts: { before: number; units: number }[] = [];
      let units = 0;
      for (const part of split(next, quantity)) {
        parts.push({ before: units, units: part });
        units += part;
      }
      // The worker may post a later refund first (an earlier one was refused meanwhile).
      const shuffled = [...parts].sort(() => next() - 0.5);
      const sum = (list: typeof parts) =>
        list.reduce((acc, p) => acc + reverseLine(rows, p.before, p.units, quantity).sale, 0n);
      expect(sum(shuffled)).toBe(sale);
      expect(sum(parts)).toBe(sale);
    }
  });
});
