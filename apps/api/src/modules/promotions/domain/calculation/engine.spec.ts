import { calculateDiscounts } from './engine';
import type {
  CalculationInput,
  CalculationOutput,
  CalculationPromotion,
  CartLine,
  ShippingCharge,
} from './types';

// The pure calculation on two Market shapes: AU (AUD, two decimals, 80 % line cap) and ZZ (JPY, no
// decimals, 60 % line cap). The same rules must hold in both; only the numbers differ.

const MARKETS = [
  { code: 'AU', currency: 'AUD', lineCapBps: 8000, unit: 10000n },
  { code: 'ZZ', currency: 'JPY', lineCapBps: 6000, unit: 10000n },
] as const;

const promo = (over: Partial<CalculationPromotion> & { id: string }): CalculationPromotion => ({
  type: 'SELLER_SALE',
  layer: 'ITEM',
  platformShareBps: 0,
  sellerId: null,
  combinable: true,
  code: null,
  specialCampaign: false,
  reward: { kind: 'PERCENT', bps: 1000 },
  maxShareBps: null,
  capAmount: null,
  maxPerOrder: null,
  budgetRemaining: null,
  minSpend: null,
  productIds: null,
  sellerIds: null,
  zones: null,
  firstOrderOnly: false,
  ...over,
});

const line = (
  id: string,
  sellerId: string,
  unitPrice: bigint,
  quantity = 1,
  productId = `p-${id}`,
): CartLine => ({
  id,
  sellerId,
  productId,
  unitPrice,
  quantity,
});

const charge = (
  id: string,
  amount: bigint,
  sellerId: string | null = null,
  zoneCode = 'Z1',
): ShippingCharge => ({
  id,
  sellerId,
  zoneCode,
  amount,
});

function run(market: (typeof MARKETS)[number], over: Partial<CalculationInput>): CalculationOutput {
  const result = calculateDiscounts({
    currency: market.currency,
    lines: [],
    shipping: [],
    promotions: [],
    code: null,
    isFirstOrder: false,
    orderCommission: 0n,
    rules: { lineDiscountCapBps: market.lineCapBps },
    ...over,
  });
  if (!result.ok) throw new Error(`calculation failed: ${result.error.path}`);
  return result.value;
}

const sumLines = (
  out: CalculationOutput,
  pick: (l: CalculationOutput['lines'][number]) => bigint,
) => out.lines.reduce((total, l) => total + pick(l), 0n);

describe.each(MARKETS)('discount calculation in market $code', (market) => {
  const P = market.unit; // a price of 100 major units

  it('gives no discount without promotions and totals the cart', () => {
    const out = run(market, {
      lines: [line('l1', 's1', P, 2), line('l2', 's2', 3n)],
      shipping: [charge('sh1', 500n)],
    });
    expect(out.totals.goodsGross).toBe(2n * P + 3n);
    expect(out.totals.goodsDiscount).toBe(0n);
    expect(out.totals.payable).toBe(2n * P + 3n + 500n);
    expect(out.code).toBe('NONE');
    expect(out.applied).toEqual([]);
  });

  describe('item layer', () => {
    it('takes a percent of the line and books it to the seller', () => {
      const out = run(market, {
        lines: [line('l1', 's1', P, 2)],
        promotions: [promo({ id: 'a', sellerId: 's1', reward: { kind: 'PERCENT', bps: 2000 } })],
      });
      expect(out.lines[0]!.discount).toBe((2n * P * 2000n) / 10000n);
      expect(out.lines[0]!.allocations).toEqual([
        {
          promotionId: 'a',
          layer: 'ITEM',
          amount: 4000n,
          sellerShare: 4000n,
          platformShare: 0n,
        },
      ]);
    });

    it('takes a fixed amount off each unit', () => {
      const out = run(market, {
        lines: [line('l1', 's1', P, 3)],
        promotions: [promo({ id: 'a', sellerId: 's1', reward: { kind: 'FIXED', amount: 700n } })],
      });
      expect(out.lines[0]!.discount).toBe(2100n);
    });

    it('applies a seller sale to that seller lines only', () => {
      const out = run(market, {
        lines: [line('l1', 's1', P), line('l2', 's2', P)],
        promotions: [promo({ id: 'a', sellerId: 's1', reward: { kind: 'PERCENT', bps: 1000 } })],
      });
      expect(out.lines[0]!.discount).toBe(1000n);
      expect(out.lines[1]!.discount).toBe(0n);
    });

    it('targets products and sellers; an empty target list matches nothing', () => {
      const out = run(market, {
        lines: [line('l1', 's1', P, 1, 'pa'), line('l2', 's1', P, 1, 'pb')],
        promotions: [promo({ id: 'a', productIds: ['pb'] }), promo({ id: 'b', sellerIds: [] })],
      });
      expect(out.lines[0]!.discount).toBe(0n);
      expect(out.lines[1]!.discount).toBe(1000n);
    });

    it('gives one item discount per line: the best for the buyer', () => {
      const out = run(market, {
        lines: [line('l1', 's1', P)],
        promotions: [
          promo({ id: 'small', reward: { kind: 'PERCENT', bps: 1000 } }),
          promo({ id: 'big', reward: { kind: 'PERCENT', bps: 3000 } }),
        ],
      });
      expect(out.lines[0]!.allocations.map((a) => a.promotionId)).toEqual(['big']);
      expect(out.lines[0]!.discount).toBe(3000n);
    });

    it('prefers the seller-funded promotion on a tie, then the smaller id', () => {
      const tie = run(market, {
        lines: [line('l1', 's1', P)],
        promotions: [
          promo({ id: 'a-platform', platformShareBps: 10000 }),
          promo({ id: 'z-seller' }),
        ],
        orderCommission: 100000n,
      });
      expect(tie.lines[0]!.allocations.map((a) => a.promotionId)).toEqual(['z-seller']);
      const ids = run(market, {
        lines: [line('l1', 's1', P)],
        promotions: [promo({ id: 'b' }), promo({ id: 'a' })],
      });
      expect(ids.lines[0]!.allocations.map((a) => a.promotionId)).toEqual(['a']);
    });

    it('caps all discounts on a line at the Market line cap and never below zero', () => {
      const out = run(market, {
        lines: [line('l1', 's1', P)],
        promotions: [promo({ id: 'a', reward: { kind: 'PERCENT', bps: 9500 } })],
      });
      expect(out.lines[0]!.discount).toBe((P * BigInt(market.lineCapBps)) / 10000n);
      expect(out.lines[0]!.net).toBeGreaterThanOrEqual(0n);
      const fixed = run(market, {
        lines: [line('l1', 's1', 500n)],
        promotions: [promo({ id: 'f', reward: { kind: 'FIXED', amount: 999999n } })],
      });
      expect(fixed.lines[0]!.net).toBe(500n - (500n * BigInt(market.lineCapBps)) / 10000n);
    });

    it('holds a promotion to its own maximum share of the line, fixed amounts included', () => {
      const lines = [line('l1', 's1', P)];
      const percent = run(market, {
        lines,
        promotions: [promo({ id: 'a', maxShareBps: 700, reward: { kind: 'PERCENT', bps: 5000 } })],
      });
      expect(percent.totals.goodsDiscount).toBe(700n);
      const fixed = run(market, {
        lines,
        promotions: [
          promo({ id: 'a', maxShareBps: 700, reward: { kind: 'FIXED', amount: 5000n } }),
        ],
      });
      expect(fixed.totals.goodsDiscount).toBe(700n);
      const cart = run(market, {
        lines,
        promotions: [
          promo({
            id: 'c',
            type: 'CART_DISCOUNT',
            layer: 'SELLER_CART',
            sellerId: 's1',
            maxShareBps: 700,
            reward: { kind: 'FIXED', amount: 5000n },
          }),
        ],
      });
      expect(cart.totals.goodsDiscount).toBe(700n);
    });

    it('applies the reward cap, the per-order limit and the remaining budget', () => {
      const lines = [line('l1', 's1', P), line('l2', 's1', P)];
      const base = { id: 'a', reward: { kind: 'PERCENT', bps: 5000 } } as const;
      const capped = run(market, { lines, promotions: [promo({ ...base, capAmount: 3000n })] });
      expect(capped.totals.goodsDiscount).toBe(3000n);
      const perOrder = run(market, { lines, promotions: [promo({ ...base, maxPerOrder: 4001n })] });
      expect(perOrder.totals.goodsDiscount).toBe(4001n);
      const budget = run(market, { lines, promotions: [promo({ ...base, budgetRemaining: 1n })] });
      expect(budget.totals.goodsDiscount).toBe(1n);
      const none = run(market, { lines, promotions: [promo({ ...base, budgetRemaining: 0n })] });
      expect(none.totals.goodsDiscount).toBe(0n);
    });
  });

  describe('cart layers', () => {
    it('applies a seller cart discount on the item-discounted subtotal of that seller', () => {
      const out = run(market, {
        lines: [line('l1', 's1', P), line('l2', 's2', P)],
        promotions: [
          promo({ id: 'sale', sellerId: 's1', reward: { kind: 'PERCENT', bps: 5000 } }),
          promo({
            id: 'cart',
            type: 'CART_DISCOUNT',
            layer: 'SELLER_CART',
            sellerId: 's1',
            reward: { kind: 'PERCENT', bps: 1000 },
          }),
        ],
      });
      // 100 - 50 (sale) = 50; 10 % of 50 = 5
      expect(out.lines[0]!.discount).toBe(5000n + 500n);
      expect(out.lines[0]!.allocations.map((a) => a.layer)).toEqual(['ITEM', 'SELLER_CART']);
      expect(out.lines[1]!.discount).toBe(0n);
    });

    it('needs the minimum spend of the eligible goods', () => {
      const promotions = [
        promo({
          id: 'cart',
          type: 'CART_DISCOUNT',
          layer: 'SELLER_CART',
          sellerId: 's1',
          reward: { kind: 'FIXED', amount: 300n },
          minSpend: 2n * P,
        }),
      ];
      expect(run(market, { lines: [line('l1', 's1', P)], promotions }).totals.goodsDiscount).toBe(
        0n,
      );
      expect(
        run(market, { lines: [line('l1', 's1', P, 2)], promotions }).totals.goodsDiscount,
      ).toBe(300n);
    });

    it('splits a platform cart discount over the lines in proportion with the remainder to the largest', () => {
      const out = run(market, {
        lines: [line('a', 's1', 1000n), line('b', 's2', 2000n), line('c', 's3', 3000n)],
        promotions: [
          promo({
            id: 'p',
            type: 'CART_DISCOUNT',
            layer: 'PLATFORM_CART',
            platformShareBps: 10000,
            reward: { kind: 'FIXED', amount: 1001n },
          }),
        ],
        orderCommission: 5000n,
      });
      const byLine = out.lines.map((l) => l.discount);
      // 1001 * 1/6 = 166.8 -> 166, 333.6 -> 333, 500.5 -> 500; remainder 2 to c (largest)
      expect(byLine).toEqual([166n, 333n, 502n]);
      expect(sumLines(out, (l) => l.discount)).toBe(1001n);
      expect(out.totals.platformShare).toBe(1001n);
      expect(out.totals.sellerShare).toBe(0n);
    });

    it('never lets a line fall below the cap when a cart discount is spread', () => {
      const out = run(market, {
        lines: [line('a', 's1', 100n), line('b', 's1', 10000n)],
        promotions: [
          promo({
            id: 'cart',
            type: 'CART_DISCOUNT',
            layer: 'SELLER_CART',
            sellerId: 's1',
            reward: { kind: 'PERCENT', bps: 10000 },
          }),
        ],
      });
      for (const l of out.lines) {
        expect(l.discount).toBeLessThanOrEqual((l.gross * BigInt(market.lineCapBps)) / 10000n);
      }
    });
  });

  describe('codes', () => {
    const codePromo = promo({
      id: 'code',
      type: 'CART_CODE',
      layer: 'PLATFORM_CART',
      platformShareBps: 10000,
      code: 'WELCOME',
      reward: { kind: 'FIXED', amount: 1000n },
    });

    it('applies a code promotion only when its code is entered', () => {
      const lines = [line('l1', 's1', P)];
      const without = run(market, { lines, promotions: [codePromo], orderCommission: 5000n });
      expect(without.totals.goodsDiscount).toBe(0n);
      expect(without.code).toBe('NONE');
      const withCode = run(market, {
        lines,
        promotions: [codePromo],
        code: 'WELCOME',
        orderCommission: 5000n,
      });
      expect(withCode.totals.goodsDiscount).toBe(1000n);
      expect(withCode.code).toBe('APPLIED');
    });

    it('reports an unknown code, and a known code that gave nothing', () => {
      const lines = [line('l1', 's1', P)];
      expect(run(market, { lines, promotions: [codePromo], code: 'NOPE' }).code).toBe('UNKNOWN');
      const minSpend = { ...codePromo, minSpend: 100n * P };
      expect(
        run(market, { lines, promotions: [minSpend], code: 'WELCOME', orderCommission: 5000n })
          .code,
      ).toBe('NOT_APPLIED');
    });

    it('takes one code only: the entered one, never another code promotion', () => {
      const other = { ...codePromo, id: 'code2', code: 'OTHER' };
      const out = run(market, {
        lines: [line('l1', 's1', P)],
        promotions: [codePromo, other],
        code: 'OTHER',
        orderCommission: 5000n,
      });
      expect(out.applied.map((a) => a.promotionId)).toEqual(['code2']);
    });
  });

  describe('combining', () => {
    const sale = promo({ id: 'sale', sellerId: 's1', reward: { kind: 'PERCENT', bps: 1000 } });
    const cart = promo({
      id: 'cart',
      type: 'CART_DISCOUNT',
      layer: 'SELLER_CART',
      sellerId: 's1',
      reward: { kind: 'PERCENT', bps: 1000 },
    });

    it('stacks automatic offers of different layers', () => {
      const out = run(market, { lines: [line('l1', 's1', P)], promotions: [sale, cart] });
      expect(out.totals.goodsDiscount).toBe(1000n + 900n);
    });

    it('uses a non-combinable promotion alone when that is better for the buyer', () => {
      const big = promo({
        id: 'big',
        sellerId: 's1',
        combinable: false,
        reward: { kind: 'PERCENT', bps: 4000 },
      });
      const out = run(market, { lines: [line('l1', 's1', P)], promotions: [sale, cart, big] });
      expect(out.applied.map((a) => a.promotionId)).toEqual(['big']);
      expect(out.totals.goodsDiscount).toBe(4000n);
    });

    it('keeps the stack when it beats the non-combinable promotion', () => {
      const small = promo({
        id: 'small',
        sellerId: 's1',
        combinable: false,
        reward: { kind: 'PERCENT', bps: 500 },
      });
      const out = run(market, { lines: [line('l1', 's1', P)], promotions: [sale, cart, small] });
      expect(out.applied.map((a) => a.promotionId)).toEqual(['sale', 'cart']);
    });
  });

  describe('first order', () => {
    const firstOrder = promo({
      id: 'first',
      type: 'FIRST_ORDER',
      layer: 'PLATFORM_CART',
      platformShareBps: 10000,
      reward: { kind: 'FIXED', amount: 800n },
      minSpend: 3000n,
      firstOrderOnly: true,
    });
    const platformCode = promo({
      id: 'code',
      type: 'CART_CODE',
      layer: 'PLATFORM_CART',
      platformShareBps: 10000,
      code: 'SAVE',
      reward: { kind: 'FIXED', amount: 1500n },
    });
    const lines = [line('l1', 's1', 5000n)];

    it('applies only to a first order over the minimum spend', () => {
      expect(
        run(market, { lines, promotions: [firstOrder], isFirstOrder: true, orderCommission: 9999n })
          .totals.goodsDiscount,
      ).toBe(800n);
      expect(
        run(market, {
          lines,
          promotions: [firstOrder],
          isFirstOrder: false,
          orderCommission: 9999n,
        }).totals.goodsDiscount,
      ).toBe(0n);
      expect(
        run(market, {
          lines: [line('l1', 's1', 2999n)],
          promotions: [firstOrder],
          isFirstOrder: true,
          orderCommission: 9999n,
        }).totals.goodsDiscount,
      ).toBe(0n);
    });

    it('does not stack with a platform code: the larger wins', () => {
      const bigCode = run(market, {
        lines,
        promotions: [firstOrder, platformCode],
        code: 'SAVE',
        isFirstOrder: true,
        orderCommission: 9999n,
      });
      expect(bigCode.applied.map((a) => a.promotionId)).toEqual(['code']);
      const smallCode = run(market, {
        lines,
        promotions: [firstOrder, { ...platformCode, reward: { kind: 'FIXED', amount: 300n } }],
        code: 'SAVE',
        isFirstOrder: true,
        orderCommission: 9999n,
      });
      expect(smallCode.applied.map((a) => a.promotionId)).toEqual(['first']);
      expect(smallCode.code).toBe('NOT_APPLIED');
    });

    it('still stacks with an automatic seller discount', () => {
      const sale = promo({ id: 'sale', sellerId: 's1', reward: { kind: 'PERCENT', bps: 1000 } });
      const out = run(market, {
        lines,
        promotions: [firstOrder, sale],
        isFirstOrder: true,
        orderCommission: 9999n,
      });
      expect(out.totals.goodsDiscount).toBe(500n + 800n);
    });
  });

  describe('funding and the commission cap', () => {
    const platformCart = (over: Partial<CalculationPromotion> = {}) =>
      promo({
        id: 'plat',
        type: 'CART_DISCOUNT',
        layer: 'PLATFORM_CART',
        platformShareBps: 10000,
        reward: { kind: 'PERCENT', bps: 5000 },
        ...over,
      });
    const lines = [line('l1', 's1', P)];

    it('caps the platform share at the order commission', () => {
      const out = run(market, { lines, promotions: [platformCart()], orderCommission: 1500n });
      expect(out.totals.goodsDiscount).toBe(1500n);
      expect(out.totals.platformShare).toBe(1500n);
    });

    it('holds the seller share of a co-funded discount to the seller maximum of the line', () => {
      const co = (over: Partial<CalculationPromotion> = {}) =>
        promo({
          id: 'co',
          type: 'CO_FUNDED_CAMPAIGN',
          platformShareBps: 5000,
          sellerMaxShareBps: 3000,
          reward: { kind: 'PERCENT', bps: 8000 },
          ...over,
        });
      const out = run(market, { lines, promotions: [co()], orderCommission: 1_000_000n });
      const allocation = out.lines[0]!.allocations[0]!;
      // The seller never pays more than 30 % of the line, however large the headline reward.
      expect(allocation.sellerShare).toBeLessThanOrEqual((P * 3000n) / 10000n);
      expect(allocation.amount).toBeLessThan((P * 8000n) / 10000n);
      expect(allocation.amount).toBeGreaterThan((P * 5900n) / 10000n);
      // A fixed reward is held to the same limit.
      const fixed = run(market, {
        lines,
        promotions: [co({ reward: { kind: 'FIXED', amount: P } })],
        orderCommission: 1_000_000n,
      });
      expect(fixed.lines[0]!.allocations[0]!.sellerShare).toBeLessThanOrEqual((P * 3000n) / 10000n);
      // A reward inside the limit is untouched.
      const inside = run(market, {
        lines,
        promotions: [co({ reward: { kind: 'PERCENT', bps: 2000 } })],
        orderCommission: 1_000_000n,
      });
      expect(inside.lines[0]!.discount).toBe((P * 2000n) / 10000n);
    });

    it('holds the seller share to the maximum on every line of a split campaign', () => {
      const many = [
        line('l1', 's1', 333n, 3),
        line('l2', 's1', 701n),
        line('l3', 's2', 12345n, 2),
        line('l4', 's2', 9n),
      ];
      const out = run(market, {
        lines: many,
        promotions: [
          promo({
            id: 'co',
            type: 'CO_FUNDED_CAMPAIGN',
            platformShareBps: 3334,
            sellerMaxShareBps: 2500,
            reward: { kind: 'PERCENT', bps: 6000 },
          }),
        ],
        orderCommission: 1_000_000n,
      });
      for (const l of out.lines) {
        for (const a of l.allocations) {
          expect(a.sellerShare).toBeLessThanOrEqual((l.gross * 2500n) / 10000n);
        }
      }
      expect(out.totals.goodsDiscount).toBeGreaterThan(0n);
    });

    it('takes the platform share of a promotion once and spreads it, so sellers do not absorb every rounding cent', () => {
      const three = [line('l1', 's1', 100n), line('l2', 's1', 100n), line('l3', 's2', 100n)];
      const out = run(market, {
        lines: three,
        promotions: [
          promo({
            id: 'co',
            type: 'CO_FUNDED_CAMPAIGN',
            platformShareBps: 3334,
            reward: { kind: 'PERCENT', bps: 1000 },
          }),
        ],
        orderCommission: 1_000_000n,
      });
      // 3 x 10 = 30; floor(30 x 3334 / 10000) = 10, not 3 x floor(10 x 0.3334) = 9.
      expect(out.totals.goodsDiscount).toBe(30n);
      expect(out.totals.platformShare).toBe(10n);
      expect(out.totals.sellerShare).toBe(20n);
      // The remainder goes to the largest line, ties to the smaller id.
      expect(out.lines.map((l) => l.allocations[0]!.platformShare)).toEqual([4n, 3n, 3n]);
      expect(out.applied[0]).toMatchObject({ platformShare: 10n, sellerShare: 20n });
    });

    it('lets a special campaign go beyond the commission', () => {
      const out = run(market, {
        lines,
        promotions: [platformCart({ specialCampaign: true })],
        orderCommission: 1500n,
      });
      expect(out.totals.goodsDiscount).toBe(5000n);
      expect(out.totals.platformShare).toBe(5000n);
    });

    it('shares a co-funded discount between seller and platform per line', () => {
      const out = run(market, {
        lines: [line('l1', 's1', P), line('l2', 's1', 3n)],
        promotions: [
          promo({
            id: 'co',
            type: 'CO_FUNDED_CAMPAIGN',
            platformShareBps: 5000,
            sellerIds: ['s1'],
            reward: { kind: 'PERCENT', bps: 2000 },
          }),
        ],
        orderCommission: 99999n,
      });
      const first = out.lines[0]!.allocations[0]!;
      expect(first.amount).toBe(2000n);
      expect(first.platformShare).toBe(1000n);
      expect(first.sellerShare).toBe(1000n);
      for (const l of out.lines) {
        for (const a of l.allocations) expect(a.sellerShare + a.platformShare).toBe(a.amount);
      }
    });

    it('trims a co-funded discount so the platform share fits the commission', () => {
      const out = run(market, {
        lines,
        promotions: [
          promo({
            id: 'co',
            type: 'CO_FUNDED_CAMPAIGN',
            platformShareBps: 5000,
            sellerIds: ['s1'],
            reward: { kind: 'PERCENT', bps: 4000 },
          }),
        ],
        orderCommission: 600n,
      });
      expect(out.totals.platformShare).toBeLessThanOrEqual(600n);
      expect(out.totals.goodsDiscount).toBe(1200n);
    });

    it('uses the commission once across the promotions of an order', () => {
      const out = run(market, {
        lines: [line('l1', 's1', P), line('l2', 's2', P)],
        promotions: [
          platformCart({ id: 'p1', reward: { kind: 'FIXED', amount: 900n } }),
          platformCart({ id: 'p2', reward: { kind: 'FIXED', amount: 900n } }),
        ],
        orderCommission: 1000n,
      });
      expect(out.totals.platformShare).toBe(1000n);
    });

    it('does not cap a seller-funded discount by the commission', () => {
      const out = run(market, {
        lines,
        promotions: [promo({ id: 'sale', sellerId: 's1', reward: { kind: 'PERCENT', bps: 5000 } })],
        orderCommission: 0n,
      });
      expect(out.totals.goodsDiscount).toBe(5000n);
      expect(out.totals.platformShare).toBe(0n);
    });
  });

  describe('shipping', () => {
    const free = promo({
      id: 'free',
      type: 'FREE_SHIPPING',
      layer: 'SHIPPING',
      platformShareBps: 0,
      reward: { kind: 'PERCENT', bps: 10000 },
      minSpend: 5000n,
      zones: ['Z1'],
    });

    it('makes shipping free above the threshold of its zone, platform-funded whatever the promotion says', () => {
      const out = run(market, {
        lines: [line('l1', 's1', 6000n)],
        shipping: [charge('sh', 800n)],
        promotions: [free],
      });
      expect(out.shipping[0]!.discount).toBe(800n);
      expect(out.shipping[0]!.net).toBe(0n);
      expect(out.shipping[0]!.allocations[0]).toMatchObject({
        sellerShare: 0n,
        platformShare: 800n,
      });
      expect(out.totals.payable).toBe(6000n);
    });

    it('does nothing below the threshold or in another zone', () => {
      const below = run(market, {
        lines: [line('l1', 's1', 4999n)],
        shipping: [charge('sh', 800n)],
        promotions: [free],
      });
      expect(below.shipping[0]!.discount).toBe(0n);
      const zone = run(market, {
        lines: [line('l1', 's1', 6000n)],
        shipping: [charge('sh', 800n, null, 'Z2')],
        promotions: [free],
      });
      expect(zone.shipping[0]!.discount).toBe(0n);
    });

    it('measures the threshold on the goods net of discounts', () => {
      const out = run(market, {
        lines: [line('l1', 's1', 6000n)],
        shipping: [charge('sh', 800n)],
        promotions: [
          promo({ id: 'sale', sellerId: 's1', reward: { kind: 'PERCENT', bps: 2000 } }),
          free,
        ],
      });
      expect(out.shipping[0]!.discount).toBe(0n);
    });

    it('gives a cheaper shipping and never makes it negative', () => {
      const cheaper = { ...free, reward: { kind: 'FIXED', amount: 300n } } as const;
      const out = run(market, {
        lines: [line('l1', 's1', 6000n)],
        shipping: [charge('a', 800n), charge('b', 100n)],
        promotions: [cheaper],
      });
      expect(out.shipping.map((s) => s.net)).toEqual([500n, 0n]);
    });

    it('is outside the commission cap', () => {
      const out = run(market, {
        lines: [line('l1', 's1', 6000n)],
        shipping: [charge('sh', 800n)],
        promotions: [free],
        orderCommission: 0n,
      });
      expect(out.totals.shippingDiscount).toBe(800n);
    });
  });

  it('refuses malformed input without a value in the error', () => {
    const base: CalculationInput = {
      currency: market.currency,
      lines: [line('l1', 's1', P)],
      shipping: [],
      promotions: [],
      code: null,
      isFirstOrder: false,
      orderCommission: 0n,
      rules: { lineDiscountCapBps: market.lineCapBps },
    };
    const bad = (over: Partial<CalculationInput>) => {
      const result = calculateDiscounts({ ...base, ...over });
      return result.ok ? null : result.error;
    };
    expect(bad({ currency: 'au' })).toEqual({
      code: 'calculation.invalid-input',
      path: 'currency',
    });
    expect(bad({ lines: [line('l1', 's1', -1n)] })?.path).toBe('lines.unitPrice');
    expect(bad({ lines: [line('l1', 's1', 1n, 0)] })?.path).toBe('lines.quantity');
    expect(bad({ lines: [line('l1', 's1', 1n), line('l1', 's1', 1n)] })?.path).toBe('lines.id');
    expect(bad({ shipping: [charge('x', -1n)] })?.path).toBe('shipping.amount');
    expect(bad({ orderCommission: -1n })?.path).toBe('orderCommission');
    expect(bad({ rules: { lineDiscountCapBps: 0 } })?.path).toBe('rules.lineDiscountCapBps');
    expect(
      bad({ promotions: [promo({ id: 'a', reward: { kind: 'PERCENT', bps: 0 } })] })?.path,
    ).toBe('promotions.reward');
    expect(bad({ promotions: [promo({ id: 'a', maxShareBps: 0 })] })?.path).toBe(
      'promotions.maxShareBps',
    );
    expect(bad({ promotions: [promo({ id: 'a', platformShareBps: 10001 })] })?.path).toBe(
      'promotions.platformShareBps',
    );
  });

  describe('phase 2: tiered cart discount', () => {
    const tiered = (over: Partial<CalculationPromotion> = {}) =>
      promo({
        id: 'tier',
        type: 'TIERED_CART',
        layer: 'PLATFORM_CART',
        platformShareBps: 10000,
        reward: { kind: 'FIXED', amount: 1500n },
        tiers: [
          { threshold: 5000n, reward: { kind: 'FIXED', amount: 500n } },
          { threshold: 10000n, reward: { kind: 'FIXED', amount: 1500n } },
        ],
        ...over,
      });

    it('gives nothing below the first tier and the highest tier reached above it', () => {
      const below = run(market, {
        lines: [line('l1', 's1', 4999n)],
        promotions: [tiered()],
        orderCommission: 99999n,
      });
      expect(below.totals.goodsDiscount).toBe(0n);
      const first = run(market, {
        lines: [line('l1', 's1', 5000n)],
        promotions: [tiered()],
        orderCommission: 99999n,
      });
      expect(first.totals.goodsDiscount).toBe(500n);
      const second = run(market, {
        lines: [line('l1', 's1', 6000n), line('l2', 's2', 4000n)],
        promotions: [tiered()],
        orderCommission: 99999n,
      });
      // The highest tier only, never the tiers added up.
      expect(second.totals.goodsDiscount).toBe(1500n);
      expect(second.applied).toHaveLength(1);
      expect(second.applied[0]!.platformShare).toBe(1500n);
    });

    it('reads percent tiers on the goods left by the item layer', () => {
      const promotions = [
        promo({ id: 'sale', sellerId: 's1', reward: { kind: 'PERCENT', bps: 2000 } }),
        tiered({
          tiers: [
            { threshold: 5000n, reward: { kind: 'PERCENT', bps: 500 } },
            { threshold: 10000n, reward: { kind: 'PERCENT', bps: 1000 } },
          ],
        }),
      ];
      // 12 000 less the 20 % sale is 9 600: below the second tier, so the first tier's 5 %.
      const out = run(market, {
        lines: [line('l1', 's1', 12000n)],
        promotions,
        orderCommission: 99999n,
      });
      expect(out.lines[0]!.discount).toBe(2400n + 480n);
      const noSale = run(market, {
        lines: [line('l1', 's2', 12000n)],
        promotions,
        orderCommission: 99999n,
      });
      expect(noSale.lines[0]!.discount).toBe(1200n);
    });

    it('splits over the lines, books the platform share and stops at the commission', () => {
      const out = run(market, {
        lines: [line('l1', 's1', 7000n), line('l2', 's2', 3000n)],
        promotions: [tiered()],
        orderCommission: 1000n,
      });
      expect(out.totals.goodsDiscount).toBe(1000n);
      expect(out.totals.platformShare).toBe(1000n);
      expect(out.lines[0]!.discount + out.lines[1]!.discount).toBe(1000n);
      const free = run(market, {
        lines: [line('l1', 's1', 7000n), line('l2', 's2', 3000n)],
        promotions: [tiered({ specialCampaign: true })],
        orderCommission: 0n,
      });
      expect(free.totals.goodsDiscount).toBe(1500n);
    });

    it('does not depend on the order of the tiers', () => {
      const a = tiered();
      const b = tiered({ tiers: [...a.tiers!].reverse() });
      const lines = [line('l1', 's1', 10000n)];
      expect(run(market, { lines, promotions: [b], orderCommission: 9999n })).toEqual(
        run(market, { lines, promotions: [a], orderCommission: 9999n }),
      );
    });

    it('refuses tiers that are not valid', () => {
      for (const tiers of [
        [],
        [
          { threshold: 100n, reward: { kind: 'FIXED', amount: 1n } },
          { threshold: 100n, reward: { kind: 'FIXED', amount: 2n } },
        ],
        [{ threshold: -1n, reward: { kind: 'FIXED', amount: 1n } }],
        [{ threshold: 1n, reward: { kind: 'PERCENT', bps: 0 } }],
      ] as const) {
        const result = calculateDiscounts({
          currency: market.currency,
          lines: [line('l1', 's1', 100n)],
          shipping: [],
          promotions: [tiered({ tiers })],
          code: null,
          isFirstOrder: false,
          orderCommission: 0n,
          rules: { lineDiscountCapBps: market.lineCapBps },
        });
        expect(result.ok ? null : result.error.path).toBe('promotions.tiers');
      }
    });
  });

  describe('phase 2: buy X get Y', () => {
    const bxgy = (over: Partial<CalculationPromotion> = {}) =>
      promo({
        id: 'bxgy',
        type: 'BUY_X_GET_Y',
        sellerId: 's1',
        reward: { kind: 'PERCENT', bps: 10000 },
        buyXGetY: { buyQty: 2, getQty: 1, maxRepeats: null },
        ...over,
      });

    it('gives the third unit free and repeats per complete group', () => {
      const discountFor = (quantity: number) =>
        run(market, { lines: [line('l1', 's1', 1000n, quantity)], promotions: [bxgy()] }).lines[0]!
          .discount;
      expect(discountFor(2)).toBe(0n);
      expect(discountFor(3)).toBe(1000n);
      expect(discountFor(5)).toBe(1000n);
      expect(discountFor(6)).toBe(2000n);
    });

    it('limits the groups of one order', () => {
      const out = run(market, {
        lines: [line('l1', 's1', 1000n, 9)],
        promotions: [bxgy({ buyXGetY: { buyQty: 2, getQty: 1, maxRepeats: 2 } })],
      });
      expect(out.lines[0]!.discount).toBe(2000n);
    });

    it('rewards the cheapest units of the qualifying lines', () => {
      const out = run(market, {
        lines: [line('a', 's1', 1000n, 2, 'pa'), line('b', 's1', 400n, 1, 'pb')],
        promotions: [bxgy()],
      });
      // Free, but all discounts together take at most the Market's share of a line.
      expect(out.lines.find((l) => l.lineId === 'b')!.discount).toBe(
        (400n * BigInt(market.lineCapBps)) / 10000n,
      );
      expect(out.lines.find((l) => l.lineId === 'a')!.discount).toBe(0n);
    });

    it('takes a percent or a fixed amount off the rewarded units, never above their price', () => {
      const half = run(market, {
        lines: [line('l1', 's1', 1001n, 3)],
        promotions: [bxgy({ reward: { kind: 'PERCENT', bps: 5000 } })],
      });
      expect(half.lines[0]!.discount).toBe(500n);
      const fixed = run(market, {
        lines: [line('l1', 's1', 1001n, 3)],
        promotions: [bxgy({ reward: { kind: 'FIXED', amount: 300n } })],
      });
      expect(fixed.lines[0]!.discount).toBe(300n);
      const over = run(market, {
        lines: [line('l1', 's1', 200n, 3)],
        promotions: [bxgy({ reward: { kind: 'FIXED', amount: 300n } })],
      });
      expect(over.lines[0]!.discount).toBe(200n);
    });

    it('is held to the share of the line a seller may give', () => {
      const out = run(market, {
        lines: [line('l1', 's1', 1000n, 2)],
        promotions: [
          bxgy({ buyXGetY: { buyQty: 1, getQty: 1, maxRepeats: null }, maxShareBps: 3000 }),
        ],
      });
      expect(out.lines[0]!.discount).toBe(600n);
    });

    it('covers a whole line by the better of its offers, never one unit by each', () => {
      const lines = [line('l1', 's1', 1000n, 3)];
      const weak = run(market, {
        lines,
        promotions: [
          promo({ id: 'sale', sellerId: 's1', reward: { kind: 'PERCENT', bps: 2000 } }),
          bxgy(),
        ],
      });
      expect(weak.lines[0]!.allocations.map((a) => [a.promotionId, a.amount])).toEqual([
        ['bxgy', 1000n],
      ]);
      const strong = run(market, {
        lines,
        promotions: [
          promo({ id: 'sale', sellerId: 's1', reward: { kind: 'PERCENT', bps: 4000 } }),
          bxgy(),
        ],
      });
      expect(strong.lines[0]!.allocations.map((a) => [a.promotionId, a.amount])).toEqual([
        ['sale', 1200n],
      ]);
    });

    it('rewards only the lines of its seller and products', () => {
      const out = run(market, {
        lines: [line('l1', 's1', 1000n, 3, 'pa'), line('l2', 's2', 1000n, 3, 'pa')],
        promotions: [bxgy({ productIds: ['pa'] })],
      });
      expect(out.lines.map((l) => l.discount)).toEqual([1000n, 0n]);
      const none = run(market, {
        lines: [line('l1', 's1', 1000n, 3, 'pb')],
        promotions: [bxgy({ productIds: ['pa'] })],
      });
      expect(none.totals.goodsDiscount).toBe(0n);
    });
  });

  describe('phase 2: multi-buy', () => {
    const multi = (over: Partial<CalculationPromotion> = {}) =>
      promo({
        id: 'multi',
        type: 'MULTI_BUY',
        sellerId: 's1',
        reward: { kind: 'FIXED', amount: 1000n },
        multiBuy: { groupQty: 3, groupPrice: 1000n, maxRepeats: null },
        ...over,
      });

    it('prices every complete group at the group price', () => {
      const discountFor = (quantity: number) =>
        run(market, { lines: [line('l1', 's1', 400n, quantity)], promotions: [multi()] }).lines[0]!
          .discount;
      expect(discountFor(2)).toBe(0n);
      expect(discountFor(3)).toBe(200n);
      expect(discountFor(5)).toBe(200n);
      expect(discountFor(6)).toBe(400n);
    });

    it('limits the groups of one order', () => {
      const out = run(market, {
        lines: [line('l1', 's1', 400n, 9)],
        promotions: [multi({ multiBuy: { groupQty: 3, groupPrice: 1000n, maxRepeats: 1 } })],
      });
      expect(out.lines[0]!.discount).toBe(200n);
    });

    it('never raises a price: a group price above the units cost gives nothing', () => {
      const out = run(market, {
        lines: [line('l1', 's1', 300n, 3)],
        promotions: [multi()],
      });
      expect(out.totals.goodsDiscount).toBe(0n);
    });

    it('groups the cheapest units of several lines and splits the discount by their cost', () => {
      const out = run(market, {
        lines: [line('a', 's1', 500n, 2, 'pa'), line('b', 's1', 300n, 2, 'pb')],
        promotions: [multi()],
      });
      // Cheapest three units: b, b and one a: 300 + 300 + 500 = 1100, 100 above the group price.
      const a = out.lines.find((l) => l.lineId === 'a')!;
      const b = out.lines.find((l) => l.lineId === 'b')!;
      expect(a.discount + b.discount).toBe(100n);
      expect(b.discount).toBe(55n);
      expect(a.discount).toBe(45n);
    });
  });

  describe('phase 2: bundle', () => {
    const bundle = (over: Partial<CalculationPromotion> = {}) =>
      promo({
        id: 'bundle',
        type: 'BUNDLE',
        sellerId: 's1',
        reward: { kind: 'FIXED', amount: 400n },
        productIds: ['cheese', 'bread', 'jam'],
        bundle: {
          items: [
            { productId: 'cheese', quantity: 1 },
            { productId: 'bread', quantity: 1 },
            { productId: 'jam', quantity: 1 },
          ],
          amountOff: 400n,
          maxRepeats: null,
        },
        ...over,
      });
    const cart = (cheese = 1, bread = 1, jam = 1) => [
      line('l1', 's1', 1500n, cheese, 'cheese'),
      line('l2', 's1', 500n, bread, 'bread'),
      line('l3', 's1', 800n, jam, 'jam'),
    ];

    it('takes the amount off a complete set and spreads it over the lines by their value', () => {
      const out = run(market, { lines: cart(), promotions: [bundle()] });
      expect(out.lines.map((l) => l.discount)).toEqual([215n, 71n, 114n]);
      expect(out.totals.goodsDiscount).toBe(400n);
    });

    it('needs every item of the set', () => {
      const out = run(market, { lines: cart().slice(0, 2), promotions: [bundle()] });
      expect(out.totals.goodsDiscount).toBe(0n);
    });

    it('counts complete sets and limits them', () => {
      expect(
        run(market, { lines: cart(2, 1, 3), promotions: [bundle()] }).totals.goodsDiscount,
      ).toBe(400n);
      expect(
        run(market, { lines: cart(2, 2, 2), promotions: [bundle()] }).totals.goodsDiscount,
      ).toBe(800n);
      const limited = bundle({
        bundle: { ...bundle().bundle!, maxRepeats: 1 },
      });
      expect(
        run(market, { lines: cart(2, 2, 2), promotions: [limited] }).totals.goodsDiscount,
      ).toBe(400n);
    });

    it('needs the quantity each item has in the set', () => {
      const two = bundle({
        bundle: {
          items: [
            { productId: 'cheese', quantity: 2 },
            { productId: 'bread', quantity: 1 },
          ],
          amountOff: 300n,
          maxRepeats: null,
        },
        productIds: ['cheese', 'bread'],
      });
      expect(
        run(market, { lines: cart(1, 1, 0 + 1), promotions: [two] }).totals.goodsDiscount,
      ).toBe(0n);
      expect(run(market, { lines: cart(3, 1, 1), promotions: [two] }).totals.goodsDiscount).toBe(
        300n,
      );
    });

    it('never takes more than the units cost, and ignores another seller', () => {
      const big = bundle({ bundle: { ...bundle().bundle!, amountOff: 99999n } });
      const out = run(market, { lines: cart(), promotions: [big] });
      // The line cap holds the discount to its share of each line.
      expect(out.totals.goodsDiscount).toBeLessThanOrEqual(
        (2800n * BigInt(market.lineCapBps)) / 10000n,
      );
      const other = run(market, {
        lines: [
          line('l1', 's2', 1500n, 1, 'cheese'),
          line('l2', 's2', 500n, 1, 'bread'),
          line('l3', 's2', 800n, 1, 'jam'),
        ],
        promotions: [bundle()],
      });
      expect(other.totals.goodsDiscount).toBe(0n);
    });
  });

  describe('phase 2: flash sale (limit of units)', () => {
    const flash = (over: Partial<CalculationPromotion> = {}) =>
      promo({
        id: 'flash',
        type: 'FLASH_SALE',
        sellerId: 's1',
        reward: { kind: 'PERCENT', bps: 2000 },
        unitLimit: 2,
        ...over,
      });

    it('discounts at most the units that are left', () => {
      const out = run(market, { lines: [line('l1', 's1', 1000n, 5)], promotions: [flash()] });
      expect(out.lines[0]!.discount).toBe(400n);
      const none = run(market, {
        lines: [line('l1', 's1', 1000n, 5)],
        promotions: [flash({ unitLimit: 0 })],
      });
      expect(none.totals.goodsDiscount).toBe(0n);
      const unlimited = run(market, {
        lines: [line('l1', 's1', 1000n, 5)],
        promotions: [flash({ unitLimit: null })],
      });
      expect(unlimited.lines[0]!.discount).toBe(1000n);
    });

    it('spends the limit on the dearest unit price first, whatever the order of the lines', () => {
      const lines = [line('l1', 's1', 500n, 2, 'pa'), line('l2', 's1', 1000n, 2, 'pb')];
      const promotions = [flash({ unitLimit: 3 })];
      const out = run(market, { lines, promotions });
      expect(out.lines.map((l) => l.discount)).toEqual([100n, 400n]);
      expect(run(market, { lines: [...lines].reverse(), promotions })).toEqual(out);
    });

    it('keeps its units for the lines it wins', () => {
      const lines = [line('l1', 's1', 500n, 1, 'pa'), line('l2', 's1', 1000n, 1, 'pb')];
      const out = run(market, {
        lines,
        promotions: [
          flash({ unitLimit: 1 }),
          promo({
            id: 'deep',
            sellerId: 's1',
            productIds: ['pb'],
            reward: { kind: 'PERCENT', bps: 5000 },
          }),
        ],
      });
      // l2 prefers the deeper sale, so the single flash unit goes to l1.
      expect(out.lines.map((l) => [l.allocations[0]!.promotionId, l.discount])).toEqual([
        ['flash', 100n],
        ['deep', 500n],
      ]);
    });

    it('holds a fixed amount to the units that are left, not the whole line', () => {
      // Platform flash sale, 50.00 off per unit, one unit left, a line of 5 units at 20.00, cap 50 %.
      const out = run(market, {
        lines: [line('l1', 's1', 2000n, 5)],
        promotions: [
          flash({
            sellerId: null,
            platformShareBps: 10000,
            reward: { kind: 'FIXED', amount: 5000n },
            unitLimit: 1,
          }),
        ],
        orderCommission: 100000n,
        rules: { lineDiscountCapBps: 5000 },
      });
      // One unit costs 20.00 and the cap takes half of it.
      expect(out.lines[0]!.discount).toBe(1000n);
      const wide = run(market, {
        lines: [line('l1', 's1', 2000n, 5)],
        promotions: [
          flash({
            sellerId: null,
            platformShareBps: 10000,
            reward: { kind: 'FIXED', amount: 5000n },
            unitLimit: 1,
          }),
        ],
        orderCommission: 100000n,
        rules: { lineDiscountCapBps: 10000 },
      });
      expect(wide.lines[0]!.discount).toBe(2000n);
    });

    it('holds the share maximum to the covered units of a limited promotion', () => {
      const out = run(market, {
        lines: [line('l1', 's1', 1000n, 10)],
        promotions: [
          flash({ unitLimit: 1, maxShareBps: 5000, reward: { kind: 'PERCENT', bps: 10000 } }),
        ],
      });
      expect(out.lines[0]!.discount).toBe(500n);
    });

    it('works for the platform, which pays its share inside the commission', () => {
      const out = run(market, {
        lines: [line('l1', 's1', 1000n, 3)],
        promotions: [flash({ sellerId: null, platformShareBps: 10000 })],
        orderCommission: 150n,
      });
      expect(out.totals.goodsDiscount).toBe(150n);
      expect(out.totals.platformShare).toBe(150n);
    });
  });

  describe('phase 2: units that qualify a multi-unit offer are paid at full price', () => {
    const bxgy = promo({
      id: 'bxgy',
      type: 'BUY_X_GET_Y',
      sellerId: 's1',
      reward: { kind: 'PERCENT', bps: 10000 },
      buyXGetY: { buyQty: 1, getQty: 1, maxRepeats: null },
    });
    const sale = (bps: number) =>
      promo({ id: 'sale', sellerId: 's1', productIds: ['pa'], reward: { kind: 'PERCENT', bps } });
    const lines = [line('l1', 's1', 1000n, 1, 'pa'), line('l2', 's1', 500n, 1, 'pb')];

    it('does not count a unit another offer discounts as the buy unit', () => {
      const out = run(market, { lines, promotions: [bxgy, sale(5000)] });
      // l1 takes the sale, so l2 has no unit to be bought with and is not free.
      expect(out.lines.map((l) => [l.lineId, l.discount])).toEqual([
        ['l1', 500n],
        ['l2', 0n],
      ]);
    });

    it('gives the free unit when no other offer takes a line of the pool', () => {
      const freeUnit = (500n * BigInt(market.lineCapBps)) / 10000n;
      const out = run(market, { lines, promotions: [bxgy] });
      expect(out.lines.map((l) => [l.lineId, l.discount])).toEqual([
        ['l1', 0n],
        ['l2', freeUnit],
      ]);
      // A sale on another seller's product leaves the pool alone.
      const other = run(market, {
        lines: [...lines, line('l3', 's2', 900n, 1, 'pc')],
        promotions: [
          bxgy,
          promo({ id: 'sale', sellerId: 's2', reward: { kind: 'PERCENT', bps: 5000 } }),
        ],
      });
      expect(other.lines.map((l) => [l.lineId, l.discount])).toEqual([
        ['l1', 0n],
        ['l2', freeUnit],
        ['l3', 450n],
      ]);
    });

    it('gives the same answer in any order and never discounts a pool line twice', () => {
      const promotions = [bxgy, sale(5000)];
      const out = run(market, { lines, promotions });
      expect(
        run(market, { lines: [...lines].reverse(), promotions: [...promotions].reverse() }),
      ).toEqual(out);
      for (const l of out.lines) {
        expect(l.allocations.filter((a) => a.layer === 'ITEM').length).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('phase 2: single-use batch codes', () => {
    const batch = (id: string, code: string | null, over: Partial<CalculationPromotion> = {}) =>
      promo({
        id,
        type: 'BATCH_CODE',
        layer: 'PLATFORM_CART',
        platformShareBps: 10000,
        code,
        reward: { kind: 'FIXED', amount: 500n },
        ...over,
      });
    const lines = [line('l1', 's1', 5000n)];

    it('uses one code per order when a public code and a batch code share their text', () => {
      const out = run(market, {
        lines,
        code: 'SAME',
        orderCommission: 100000n,
        promotions: [
          batch('batch', 'SAME'),
          promo({
            id: 'public',
            type: 'CART_CODE',
            layer: 'PLATFORM_CART',
            platformShareBps: 10000,
            code: 'SAME',
            reward: { kind: 'FIXED', amount: 300n },
          }),
        ],
      });
      expect(out.applied.map((a) => a.promotionId)).toEqual(['batch']);
      expect(out.totals.goodsDiscount).toBe(500n);
    });

    it('applies the entered code once and reports it applied', () => {
      const out = run(market, {
        lines,
        promotions: [batch('b1', 'AAAA')],
        code: 'AAAA',
        orderCommission: 9999n,
      });
      expect(out.code).toBe('APPLIED');
      expect(out.totals.goodsDiscount).toBe(500n);
    });

    it('gives nothing for a code that was already used', () => {
      const out = run(market, {
        lines,
        promotions: [batch('b1', 'AAAA', { codeUsed: true })],
        code: 'AAAA',
        orderCommission: 9999n,
      });
      expect(out.code).toBe('NOT_APPLIED');
      expect(out.totals.goodsDiscount).toBe(0n);
    });

    it('applies one code per order and only the entered one', () => {
      const out = run(market, {
        lines,
        promotions: [
          batch('b1', 'AAAA'),
          batch('b2', 'BBBB'),
          promo({
            id: 'public',
            type: 'CART_CODE',
            layer: 'PLATFORM_CART',
            platformShareBps: 10000,
            code: 'PUB',
            reward: { kind: 'FIXED', amount: 700n },
          }),
        ],
        code: 'BBBB',
        orderCommission: 9999n,
      });
      expect(out.applied.map((a) => a.promotionId)).toEqual(['b2']);
      const noCode = run(market, {
        lines,
        promotions: [batch('b1', 'AAAA')],
        orderCommission: 9999n,
      });
      expect(noCode.totals.goodsDiscount).toBe(0n);
      expect(noCode.code).toBe('NONE');
    });

    it('does not stack with the first-order discount: the larger applies', () => {
      const first = promo({
        id: 'first',
        type: 'FIRST_ORDER',
        layer: 'PLATFORM_CART',
        platformShareBps: 10000,
        firstOrderOnly: true,
        reward: { kind: 'FIXED', amount: 800n },
      });
      const out = run(market, {
        lines,
        promotions: [batch('b1', 'AAAA'), first],
        code: 'AAAA',
        isFirstOrder: true,
        orderCommission: 9999n,
      });
      expect(out.applied.map((a) => a.promotionId)).toEqual(['first']);
    });
  });

  describe('phase 2: invariants over generated carts', () => {
    let seed = 987;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const shuffled = <T>(items: readonly T[]): T[] => {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i--) {
        const j = next(i + 1);
        [copy[i], copy[j]] = [copy[j]!, copy[i]!];
      }
      return copy;
    };

    it('keeps the books exact, the caps and the order independence for the new types', () => {
      for (let round = 0; round < 300; round++) {
        const lines: CartLine[] = [];
        for (let i = 0; i < 1 + next(6); i++) {
          lines.push(
            line(`l${i}`, `s${next(2)}`, BigInt(1 + next(5000)), 1 + next(6), `p${next(4)}`),
          );
        }
        const promotions: CalculationPromotion[] = [
          promo({
            id: 'bxgy',
            type: 'BUY_X_GET_Y',
            sellerId: 's0',
            maxShareBps: next(2) === 0 ? null : 1000 * (1 + next(9)),
            reward: { kind: 'PERCENT', bps: 1000 * (1 + next(10)) },
            buyXGetY: {
              buyQty: 1 + next(3),
              getQty: 1 + next(2),
              maxRepeats: next(2) === 0 ? null : 1 + next(3),
            },
          }),
          promo({
            id: 'multi',
            type: 'MULTI_BUY',
            sellerId: 's1',
            reward: { kind: 'FIXED', amount: 1n },
            multiBuy: {
              groupQty: 2 + next(3),
              groupPrice: BigInt(1 + next(8000)),
              maxRepeats: null,
            },
          }),
          promo({
            id: 'bundle',
            type: 'BUNDLE',
            sellerId: 's0',
            productIds: ['p0', 'p1'],
            reward: { kind: 'FIXED', amount: 1n },
            bundle: {
              items: [
                { productId: 'p0', quantity: 1 + next(2) },
                { productId: 'p1', quantity: 1 },
              ],
              amountOff: BigInt(1 + next(4000)),
              maxRepeats: next(2) === 0 ? null : 1 + next(2),
            },
          }),
          promo({
            id: 'flash',
            type: 'FLASH_SALE',
            sellerId: null,
            platformShareBps: 10000,
            productIds: ['p2', 'p3'],
            reward:
              next(2) === 0
                ? { kind: 'PERCENT', bps: 500 * (1 + next(19)) }
                : { kind: 'FIXED', amount: BigInt(1 + next(9000)) },
            unitLimit: next(8),
          }),
          promo({
            id: 'tier',
            type: 'TIERED_CART',
            layer: 'PLATFORM_CART',
            platformShareBps: 10000,
            reward: { kind: 'FIXED', amount: 1n },
            tiers: [
              {
                threshold: BigInt(1 + next(3000)),
                reward: { kind: 'FIXED', amount: BigInt(1 + next(500)) },
              },
              {
                threshold: BigInt(3001 + next(9000)),
                reward: { kind: 'FIXED', amount: BigInt(501 + next(900)) },
              },
            ],
          }),
          promo({
            id: 'batch',
            type: 'BATCH_CODE',
            layer: 'PLATFORM_CART',
            platformShareBps: 10000,
            code: 'C',
            codeUsed: next(4) === 0,
            reward: { kind: 'PERCENT', bps: 100 * (1 + next(40)) },
          }),
        ];
        const commission = BigInt(next(3000));
        const input = {
          lines,
          promotions,
          code: next(2) === 0 ? 'C' : null,
          orderCommission: commission,
        };
        const out = run(market, input);
        let platformShare = 0n;
        for (const l of out.lines) {
          expect(l.allocations.reduce((t, a) => t + a.amount, 0n)).toBe(l.discount);
          expect(l.net).toBeGreaterThanOrEqual(0n);
          expect(l.discount).toBeLessThanOrEqual((l.gross * BigInt(market.lineCapBps)) / 10000n);
          expect(l.allocations.filter((a) => a.layer === 'ITEM').length).toBeLessThanOrEqual(1);
          for (const a of l.allocations) {
            expect(a.amount).toBeGreaterThan(0n);
            expect(a.sellerShare + a.platformShare).toBe(a.amount);
            platformShare += a.platformShare;
          }
        }
        expect(platformShare).toBeLessThanOrEqual(commission);
        const flashPromotion = promotions.find((p) => p.id === 'flash')!;
        const dearest = lines.reduce((m, l) => (l.unitPrice > m ? l.unitPrice : m), 0n);
        const flashTotal = out.applied.find((a) => a.promotionId === 'flash')?.amount ?? 0n;
        // No more than the limit's units at the dearest price, at the sale percent or the fixed
        // amount (itself held to the unit price), whatever the cap and the line sizes.
        const reward = flashPromotion.reward;
        const perUnit =
          reward.kind === 'PERCENT'
            ? (dearest * BigInt(reward.bps)) / 10000n + 1n
            : reward.amount < dearest
              ? reward.amount
              : dearest;
        expect(flashTotal).toBeLessThanOrEqual(BigInt(flashPromotion.unitLimit!) * perUnit);
        // The same answer in any order of lines and promotions.
        const again = run(market, {
          ...input,
          lines: shuffled(lines),
          promotions: shuffled(promotions),
        });
        expect(again).toEqual(out);
      }
    });
  });

  describe('invariants over generated carts', () => {
    // A small seeded generator, so the carts are the same on every run.
    let seed = 12345;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };

    it('keeps the books exact, nothing below zero, the cap and the commission respected', () => {
      for (let round = 0; round < 200; round++) {
        const lines: CartLine[] = [];
        for (let i = 0; i < 1 + next(5); i++) {
          lines.push(
            line(`l${i}`, `s${next(3)}`, BigInt(1 + next(20000)), 1 + next(4), `p${next(4)}`),
          );
        }
        const promotions: CalculationPromotion[] = [
          promo({
            id: 'sale',
            sellerId: 's0',
            reward: { kind: 'PERCENT', bps: 100 * (1 + next(99)) },
          }),
          promo({
            id: 'co',
            type: 'CO_FUNDED_CAMPAIGN',
            platformShareBps: 1 + next(9999),
            sellerMaxShareBps: 500 + next(5000),
            sellerIds: ['s1', 's2'],
            reward: { kind: 'FIXED', amount: BigInt(1 + next(500)) },
          }),
          promo({
            id: 'cart1',
            type: 'CART_DISCOUNT',
            layer: 'SELLER_CART',
            sellerId: 's1',
            reward: { kind: 'PERCENT', bps: 100 * (1 + next(99)) },
          }),
          promo({
            id: 'plat',
            type: 'CART_CODE',
            layer: 'PLATFORM_CART',
            platformShareBps: 10000,
            code: 'C',
            reward: { kind: 'FIXED', amount: BigInt(1 + next(30000)) },
          }),
          promo({
            id: 'first',
            type: 'FIRST_ORDER',
            layer: 'PLATFORM_CART',
            platformShareBps: 10000,
            firstOrderOnly: true,
            reward: { kind: 'PERCENT', bps: 100 * (1 + next(50)) },
          }),
          promo({
            id: 'ship',
            type: 'FREE_SHIPPING',
            layer: 'SHIPPING',
            reward: { kind: 'PERCENT', bps: 100 * (1 + next(100)) },
            minSpend: BigInt(next(10000)),
          }),
          promo({
            id: 'alone',
            sellerId: 's2',
            combinable: false,
            reward: { kind: 'PERCENT', bps: 100 * (1 + next(99)) },
          }),
        ];
        const commission = BigInt(next(5000));
        const out = run(market, {
          lines,
          shipping: [charge('sh1', BigInt(next(2000)), null, 'Z1')],
          promotions,
          code: next(2) === 0 ? 'C' : null,
          isFirstOrder: next(2) === 0,
          orderCommission: commission,
        });
        let sellerShare = 0n;
        let platformShare = 0n;
        for (const l of out.lines) {
          const sum = l.allocations.reduce((t, a) => t + a.amount, 0n);
          expect(sum).toBe(l.discount);
          expect(l.net).toBe(l.gross - l.discount);
          expect(l.net).toBeGreaterThanOrEqual(0n);
          expect(l.discount).toBeLessThanOrEqual((l.gross * BigInt(market.lineCapBps)) / 10000n);
          expect(l.allocations.filter((a) => a.layer === 'ITEM').length).toBeLessThanOrEqual(1);
          for (const a of l.allocations) {
            expect(a.amount).toBeGreaterThan(0n);
            expect(a.sellerShare + a.platformShare).toBe(a.amount);
            if (a.promotionId === 'co') {
              const co = promotions.find((p) => p.id === 'co')!;
              expect(a.sellerShare).toBeLessThanOrEqual(
                (l.gross * BigInt(co.sellerMaxShareBps!)) / 10000n,
              );
            }
            sellerShare += a.sellerShare;
            platformShare += a.platformShare;
          }
        }
        expect(platformShare).toBeLessThanOrEqual(commission);
        expect(out.totals.sellerShare).toBe(sellerShare);
        expect(out.totals.platformShare).toBe(platformShare);
        for (const s of out.shipping) {
          expect(s.net).toBeGreaterThanOrEqual(0n);
          expect(s.discount + s.net).toBe(s.gross);
        }
        expect(out.totals.payable).toBe(out.totals.goodsNet + out.totals.shippingNet);
      }
    });

    it('gives the same answer whatever the order of the input', () => {
      const lines = [line('b', 's1', 3333n, 3), line('a', 's2', 777n), line('c', 's1', 12345n, 2)];
      const promotions = [
        promo({ id: 'y', sellerId: 's1', reward: { kind: 'PERCENT', bps: 1234 } }),
        promo({
          id: 'x',
          type: 'CART_DISCOUNT',
          layer: 'PLATFORM_CART',
          platformShareBps: 10000,
          reward: { kind: 'FIXED', amount: 1001n },
        }),
        promo({
          id: 'z',
          type: 'FREE_SHIPPING',
          layer: 'SHIPPING',
          reward: { kind: 'PERCENT', bps: 10000 },
        }),
      ];
      const shipping = [charge('s2', 400n), charge('s1', 300n)];
      const forward = run(market, { lines, promotions, shipping, orderCommission: 9000n });
      const reversed = run(market, {
        lines: [...lines].reverse(),
        promotions: [...promotions].reverse(),
        shipping: [...shipping].reverse(),
        orderCommission: 9000n,
      });
      expect(reversed).toEqual(forward);
    });
  });
});
