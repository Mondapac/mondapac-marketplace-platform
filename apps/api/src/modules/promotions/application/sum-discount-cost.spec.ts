import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { MemoryRedemptions } from '../../../../test/support/promotions-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { RedemptionRecord } from '../domain/redemption';
import { PromotionsReportingFacadeImplementation } from '../presentation/promotions-reporting.facade';
import { SumDiscountCost } from './use-cases/sum-discount-cost.use-case';

// Dashboards v2, phase 2: promotions.sum-discount-cost, the discount cost of the orders paid in a
// window (both Market fixtures). Totals only, the money key, an admin acting as themselves, the
// window and currency checked, a store failure never a zero.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const FROM = Temporal.Instant.from('2026-11-15T14:00:00Z');
const TO = Temporal.Instant.from('2026-11-22T14:00:00Z');
const MONEY_KEY = 'commission-payouts.settlement.view';
const MANAGE_KEY = 'promotions.promotion.manage';

describe.each([['AU'], ['ZZ']] as const)('promotions.sum-discount-cost in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const currency = markets.get(market.marketId).defaultCurrency;
  let redemptions: MemoryRedemptions;
  let units: FakeUnitOfWork;
  let checked: string[][];
  const gate = createUseCaseGate(markets, {
    check: (_context, declaration) => {
      const { rule } = declaration;
      checked.push(rule.kind === 'permissions' ? [...(rule.allOf ?? [])] : [rule.kind]);
      return Promise.resolve({ allowed: true as const });
    },
  });
  const admin = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'admin',
      accountId: id<'Account'>(0xad),
      sessionId: id<'Session'>(0x62),
      sellerId: null,
    }),
    'discount-cost-admin',
  );
  const sellerContext = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'seller',
      accountId: id<'Account'>(0xa1),
      sessionId: id<'Session'>(0x63),
      sellerId: id<'Seller'>(0x5e1),
    }),
    'discount-cost-seller',
  );
  const facade = () =>
    new PromotionsReportingFacadeImplementation(
      new SumDiscountCost(gate, { unitOfWork: units, redemptions }),
    );

  let n = 0;
  const row = (over: Partial<RedemptionRecord>): RedemptionRecord => ({
    id: id<'Redemption'>(0x9000 + n++),
    orderId: id<'Order'>(0x0de1),
    promotionKey: 'order',
    promotionId: null,
    kind: 'ORDER',
    customerAccountId: id<'Account'>(0xb1),
    codeHash: null,
    currency,
    amount: 0n,
    sellerShare: 0n,
    platformShare: 0n,
    units: null,
    budgetMonth: null,
    status: 'CONFIRMED',
    releaseReason: null,
    reservedAt: FROM.subtract({ minutes: 5 }),
    confirmedAt: FROM.add({ hours: 1 }),
    releasedAt: null,
    ...over,
  });

  beforeEach(() => {
    redemptions = new MemoryRedemptions();
    units = new FakeUnitOfWork();
    checked = [];
  });

  it("sums the window's confirmed discounts in one read-only unit: orders by head row, released apart", async () => {
    const order1 = id<'Order'>(0x0de1);
    const order2 = id<'Order'>(0x0de2);
    const order3 = id<'Order'>(0x0de3);
    const promo = id<'Promotion'>(0x0f1);
    redemptions.rows.push(
      row({ orderId: order1 }),
      row({
        orderId: order1,
        kind: 'PROMOTION',
        promotionKey: promo,
        promotionId: promo,
        amount: 1_000n,
        platformShare: 400n,
        sellerShare: 600n,
      }),
      row({
        orderId: order1,
        kind: 'FIRST_ORDER',
        promotionKey: 'first-order',
        budgetMonth: '2026-11',
        amount: 500n,
        platformShare: 500n,
      }),
      row({ orderId: order2 }),
      row({
        orderId: order2,
        kind: 'FREE_SHIPPING',
        promotionKey: 'free-shipping:metro',
        amount: 900n,
        platformShare: 900n,
      }),
      // Refunded after payment: its discount is given back, not kept.
      row({
        orderId: order3,
        status: 'RELEASED',
        releaseReason: 'ORDER_REFUNDED',
        releasedAt: TO.add({ hours: 2 }),
      }),
      row({
        orderId: order3,
        kind: 'PROMOTION',
        promotionKey: promo,
        promotionId: promo,
        amount: 300n,
        platformShare: 100n,
        sellerShare: 200n,
        status: 'RELEASED',
        releaseReason: 'ORDER_REFUNDED',
        releasedAt: TO.add({ hours: 2 }),
      }),
      // Outside the window, still reserved, or in another currency: never counted.
      row({ orderId: id<'Order'>(0x0de4), confirmedAt: TO }),
      row({ orderId: id<'Order'>(0x0de5), confirmedAt: FROM.subtract({ seconds: 1 }) }),
      row({ orderId: id<'Order'>(0x0de6), status: 'RESERVED', confirmedAt: null }),
      row({ orderId: id<'Order'>(0x0de7), currency: currency === 'NZD' ? 'AUD' : 'NZD' }),
    );
    const out = await facade().discountCost(admin, { window: { from: FROM, to: TO }, currency });
    expect(out).toEqual({
      ok: true,
      value: {
        kept: { orders: 2, amount: 2_400n, platformShare: 1_800n, sellerShare: 600n },
        byKind: [
          { kind: 'PROMOTION', uses: 1, amount: 1_000n, platformShare: 400n, sellerShare: 600n },
          { kind: 'FIRST_ORDER', uses: 1, amount: 500n, platformShare: 500n, sellerShare: 0n },
          { kind: 'FREE_SHIPPING', uses: 1, amount: 900n, platformShare: 900n, sellerShare: 0n },
        ],
        released: { orders: 1, amount: 300n, platformShare: 100n, sellerShare: 200n },
      },
    });
    expect(units.units).toEqual([{ market: market.marketId, options: { readOnly: true } }]);
    expect(checked).toEqual([[MONEY_KEY, MANAGE_KEY]]);
  });

  it('refuses a seller and an admin acting as a seller before any read', async () => {
    const actingAs = Object.assign(
      Object.create(Object.getPrototypeOf(admin) as object) as object,
      admin,
      { actor: { ...admin.actor, actingAs: { sellerId: id(0x5e12) } } },
    ) as typeof admin;
    for (const context of [sellerContext, actingAs]) {
      const out = await facade().discountCost(context, {
        window: { from: FROM, to: TO },
        currency,
      });
      expect(out).toEqual({ ok: false, error: { code: 'access.denied' } });
    }
    expect(units.units).toEqual([]);
  });

  it('refuses an empty, reversed or over-long window and a malformed currency', async () => {
    const asks = [
      { window: { from: TO, to: TO }, currency },
      { window: { from: TO, to: FROM }, currency },
      { window: { from: FROM, to: FROM.add({ hours: 401 * 24 }) }, currency },
      { window: { from: FROM, to: 'tomorrow' as never }, currency },
      { window: { from: FROM, to: TO }, currency: 'aud' },
      { window: { from: FROM, to: TO }, currency: undefined as never },
    ];
    for (const ask of asks) {
      expect(await facade().discountCost(admin, ask)).toEqual({
        ok: false,
        error: { code: 'validation.failed' },
      });
    }
    expect(units.units).toEqual([]);
    // 400 days (13 months of Market days with a margin) is still answered.
    const longest = await facade().discountCost(admin, {
      window: { from: FROM, to: FROM.add({ hours: 400 * 24 }) },
      currency,
    });
    expect(longest.ok).toBe(true);
  });

  it('answers promotions.unavailable when the store fails, never a zero cost', async () => {
    redemptions.failDiscountCost = true;
    expect(
      await facade().discountCost(admin, { window: { from: FROM, to: TO }, currency }),
    ).toEqual({ ok: false, error: { code: 'promotions.unavailable' } });
  });
});
