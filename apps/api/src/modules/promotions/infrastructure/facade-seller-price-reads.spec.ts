import { err, money, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import type { PricingFacade } from '../../pricing';
import type { SellersFacade } from '../../sellers';
import { FacadePriceHistory, FacadeSellerActivity } from './facade-seller-price-reads';

// The bindings of promotions' seller-age and price-history ports to the sellers and pricing
// facades, on both Market fixtures: the caller's context passes unchanged, and every refusal or
// fault is "unknown" (null), which the rules read as fail closed.

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const SINCE = Temporal.Instant.from('2026-09-01T00:00:00Z');

describe.each(['AU', 'ZZ'] as const)('promotions facade reads in market %s', (code) => {
  const context = testCallContext(testMarketContext(code, 'default'), 'anonymous');
  const sellerId = id<'Seller'>(1);
  const unit = { offerId: id<'Offer'>(2), variantId: id<'Variant'>(3) };
  const price = money(1999n, code === 'AU' ? 'AUD' : 'JPY');

  describe('FacadeSellerActivity', () => {
    const over = (activeSinceOf: SellersFacade['activeSinceOf']) =>
      new FacadeSellerActivity({ activeSinceOf } as SellersFacade);

    it('answers the instant sellers gives, with the caller context unchanged', async () => {
      const calls: unknown[] = [];
      const reads = over((ctx, seller) => {
        calls.push([ctx, seller]);
        return Promise.resolve(ok(SINCE));
      });
      expect(await reads.activeSince(context, sellerId)).toBe(SINCE);
      expect(calls).toEqual([[context, sellerId]]);
    });

    it('answers null for a seller never approved, a refusal and a fault', async () => {
      expect(await over(() => Promise.resolve(ok(null))).activeSince(context, sellerId)).toBe(null);
      expect(
        await over(() =>
          Promise.resolve(err({ code: 'sellers.unavailable' as const })),
        ).activeSince(context, sellerId),
      ).toBe(null);
      expect(
        await over(() => Promise.reject(new Error('down'))).activeSince(context, sellerId),
      ).toBe(null);
    });
  });

  describe('FacadePriceHistory', () => {
    const over = (daysAtPrice: PricingFacade['daysAtPrice']) =>
      new FacadePriceHistory({ daysAtPrice } as PricingFacade);

    it('answers the days pricing gives, for the same unit, price and window', async () => {
      const calls: unknown[] = [];
      const reads = over((ctx, key, asked, windowDays) => {
        calls.push([ctx, key, asked, windowDays]);
        return Promise.resolve(ok(28));
      });
      expect(await reads.daysSoldAtPrice(context, unit, price, 90)).toBe(28);
      expect(calls).toEqual([[context, unit, price, 90]]);
    });

    it('answers null for a unit with no history, a refusal and a fault', async () => {
      expect(
        await over(() => Promise.resolve(ok(null))).daysSoldAtPrice(context, unit, price, 90),
      ).toBe(null);
      expect(
        await over(() =>
          Promise.resolve(err({ code: 'validation.failed' as const, fields: [] })),
        ).daysSoldAtPrice(context, unit, price, 90),
      ).toBe(null);
      expect(
        await over(() => Promise.reject(new Error('down'))).daysSoldAtPrice(
          context,
          unit,
          price,
          90,
        ),
      ).toBe(null);
    });
  });
});
