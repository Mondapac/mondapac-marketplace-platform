import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId } from '@mondapac/shared-kernel';
import { restoreCostAmount } from './cost-amount';
import { CostSeries } from './cost-series';

// The Cost series root (pricing design 2.1, 3.3): append-only, latest record wins, never held.
// Both Market fixtures: AU (AUD) and the synthetic ZZ (JPY).

const T0 = Temporal.Instant.from('2026-11-25T08:00:00Z');
const ids = {
  series: '01990000-0000-7000-8000-000000000001' as Id<'CostSeries'>,
  offer: '01990000-0000-7000-8000-000000000002' as Id<'Offer'>,
  variant: '01990000-0000-7000-8000-000000000003' as Id<'Variant'>,
  product: '01990000-0000-7000-8000-000000000004' as Id<'Product'>,
  seller: '01990000-0000-7000-8000-000000000005' as Id<'Seller'>,
  account: '01990000-0000-7000-8000-000000000006' as Id<'Account'>,
};
const record = (n: number) =>
  `01990000-0000-7000-8000-0000000001${n.toString().padStart(2, '0')}` as Id<'CostRecord'>;

describe.each([
  ['AU', 'AUD'],
  ['ZZ', 'JPY'],
] as const)('market %s (%s)', (code, currency) => {
  function fresh(): CostSeries {
    return CostSeries.create({
      id: ids.series,
      marketId: code as MarketId,
      offerId: ids.offer,
      variantId: ids.variant,
      productId: ids.product,
      sellerId: ids.seller,
      currency,
      now: T0,
    });
  }

  const set = (series: CostSeries, n: number, amount: bigint | null) =>
    series.setCost({
      recordId: record(n),
      amount: amount === null ? null : restoreCostAmount(amount, currency),
      submittedBy: ids.account,
      now: T0,
    });

  describe('CostSeries', () => {
    it('a first Cost appends one record and makes version 1; stored, it is the current Cost', () => {
      const series = fresh();
      expect(set(series, 1, 500n)).toEqual({
        ok: true,
        value: { kind: 'recorded', record: expect.objectContaining({ id: record(1) }) as unknown },
      });
      expect(series.state.version).toBe(1);
      series.markStored();
      expect(series.persistedVersion).toBe(1);
      expect(series.state.latest?.id).toBe(record(1));
      expect(series.state.appended).toBeNull();
    });

    it('clearing "none" and setting the current Cost again record nothing', () => {
      const series = fresh();
      expect(set(series, 1, null)).toEqual({ ok: true, value: { kind: 'unchanged' } });
      expect(series.state.version).toBe(0);
      set(series, 2, 500n);
      series.markStored();
      expect(set(series, 3, 500n)).toEqual({ ok: true, value: { kind: 'unchanged' } });
      expect(series.state.version).toBe(1);
    });

    it('a clear appends a "cleared" record; the current Cost is then none', () => {
      const series = fresh();
      set(series, 1, 500n);
      series.markStored();
      expect(set(series, 2, null).ok).toBe(true);
      expect(series.current).toBeNull();
      expect(series.state.version).toBe(2);
    });

    it('allows one write per unit of work, and none on a retired series', () => {
      const series = fresh();
      set(series, 1, 500n);
      expect(() => set(series, 2, 600n)).toThrow('one write per unit');

      const retired = CostSeries.restore({
        ...series.state,
        version: 3,
        retiredAt: T0,
        retireCause: 'offer-removed',
        latest: null,
      });
      expect(set(retired, 3, 700n)).toEqual({
        ok: false,
        error: { code: 'pricing.series-retired' },
      });
    });
  });
});
