import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { PromotionRecord } from '../domain/promotion';
import { ConfigPromotionsPolicy } from '../infrastructure/config-promotions-policy';
import { promotionsForCart } from './quote-flow';

// How stored promotions become the plain input of the pure calculation, on both Market fixtures
// (AU: tax ruling open, so platform money applies to test orders only; ZZ: ruling confirmed).

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new ConfigPromotionsPolicy(markets);
const T0 = Temporal.Instant.from('2026-10-25T10:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const SELLER = id<'Seller'>(0x5e1);
const OTHER = id<'Seller'>(0x5e2);

describe.each([['AU'], ['ZZ']] as const)('promotions for a cart in market %s', (code) => {
  const settings = policy.settings(testMarketContext(code, 'default'))!;
  const confirmed = settings.rules.gstRulingConfirmed;

  const record = (n: number, extra: Partial<PromotionRecord> = {}): PromotionRecord => ({
    id: id<'Promotion'>(0x900 + n),
    status: 'ACTIVE',
    ownerSellerId: null,
    currency: settings.currency,
    priorApproved: false,
    pausedBy: null,
    createdByAccountId: id<'Account'>(0xad),
    createdAt: T0,
    updatedAt: T0,
    type: 'CART_DISCOUNT',
    name: 'p',
    funding: 'PLATFORM',
    platformSplitBps: null,
    combinable: true,
    code: null,
    startsAt: T0,
    endsAt: null,
    testMode: false,
    specialCampaign: false,
    reward: { kind: 'PERCENT', bps: 500 },
    capMinor: null,
    maxPerOrderMinor: null,
    maxTotalUses: null,
    maxUsesPerCustomer: null,
    budgetMinor: 100000n,
    minSpendMinor: null,
    productIds: [],
    sellerIds: [],
    zones: [],
    ...extra,
  });
  const cart = (
    records: PromotionRecord[],
    extra: Partial<Parameters<typeof promotionsForCart>[0]> = {},
  ) =>
    promotionsForCart({
      records,
      usage: new Map(),
      optIns: new Map(),
      settings,
      firstOrder: null,
      thresholds: new Map(),
      zones: [],
      testMode: false,
      ...extra,
    });

  it('keeps platform money out of a real order until the tax ruling is confirmed', () => {
    const real = cart([record(1)]);
    expect(real).toHaveLength(confirmed ? 1 : 0);
    expect(cart([record(1, { testMode: true })], { testMode: true })).toHaveLength(1);
    // Seller money is never held back by the ruling.
    expect(cart([record(2, { funding: 'SELLER', ownerSellerId: SELLER })])).toHaveLength(1);
  });

  it('leaves a test-mode promotion out of a real order', () => {
    expect(cart([record(1, { funding: 'SELLER', ownerSellerId: SELLER, testMode: true })])).toEqual(
      [],
    );
  });

  it('holds a seller promotion to the lower of the maximum and the approval threshold until an admin approved it', () => {
    const own = { funding: 'SELLER' as const, ownerSellerId: SELLER };
    const [pending] = cart([record(1, own)]);
    expect(pending?.maxShareBps).toBe(
      Math.min(settings.rules.sellerMaxDiscountBps, settings.rules.priorApprovalDiscountBps),
    );
    const [approved] = cart([record(2, { ...own, priorApproved: true })]);
    expect(approved?.maxShareBps).toBe(settings.rules.sellerMaxDiscountBps);
  });

  it('leaves a promotion out once its total uses or its budget are gone', () => {
    const limited = record(1, { funding: 'SELLER', ownerSellerId: SELLER, maxTotalUses: 2 });
    const usage = new Map([
      [limited.id, { usesCount: 2, spentMinor: 0n, sellerShareMinor: 0n, platformShareMinor: 0n }],
    ]);
    expect(cart([limited], { usage })).toEqual([]);

    const budget = record(2, { budgetMinor: 1000n, testMode: true });
    const spent = new Map([
      [
        budget.id,
        { usesCount: 1, spentMinor: 1200n, sellerShareMinor: 0n, platformShareMinor: 0n },
      ],
    ]);
    const [left] = cart([budget], { usage: spent, testMode: true });
    expect(left?.budgetRemaining).toBe(0n);
  });

  it('puts a co-funded campaign on the sellers that opted in and that it is aimed at', () => {
    const campaign = record(1, {
      type: 'CO_FUNDED_CAMPAIGN',
      funding: 'CO_FUNDED',
      platformSplitBps: 4000,
      testMode: true,
      sellerIds: [SELLER],
    });
    expect(cart([campaign], { testMode: true })).toEqual([]);
    const optIns = new Map([[campaign.id, [SELLER, OTHER]]]);
    const [applied] = cart([campaign], { optIns, testMode: true });
    expect(applied?.sellerIds).toEqual([SELLER]);
    expect(applied?.platformShareBps).toBe(4000);
  });

  it('adds the first-order discount and a free-shipping rule per zone, each with its own threshold', () => {
    const firstOrder = {
      enabled: true,
      kind: 'FIXED' as const,
      percentBps: null,
      amountMinor: 800n,
      capMinor: null,
      minSpendMinor: 3000n,
      monthlyBudgetMinor: 100000n,
    };
    const result = cart([], {
      firstOrder,
      zones: ['city', 'remote'],
      thresholds: new Map([['remote', 12000n]]),
      testMode: true,
    });
    expect(result.map((p) => p.id)).toEqual([
      'first-order',
      'free-shipping:city',
      'free-shipping:remote',
    ]);
    expect(result[0]?.firstOrderOnly).toBe(true);
    expect(result[1]?.minSpend).toBe(settings.freeShippingThresholdMinor);
    expect(result[2]?.minSpend).toBe(12000n);

    // Off, and held back in a real order while the ruling is open.
    expect(cart([], { firstOrder: { ...firstOrder, enabled: false } })).toEqual([]);
    expect(cart([], { firstOrder, zones: ['city'] })).toHaveLength(confirmed ? 2 : 0);
  });
});
