import { QuoteOwnDiscounts } from './use-cases/quote-own-discounts.use-case';
import { RedeemOwnDiscounts } from './use-cases/redeem-own-discounts.use-case';
import { ListStaleRedemptions } from './use-cases/list-stale-redemptions.use-case';
import { SettleRedemptions } from './use-cases/settle-redemptions.use-case';
import { money, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import {
  FakeBatchCodeCrypto,
  FakePriceHistory,
  FakeSellerActivity,
  FakeSellerCatalogue,
  FakeSellerCommission,
  FakeStepUp,
  MemoryBatchCodes,
  MemoryFirstOrder,
  MemoryOptIns,
  MemoryPromotions,
  MemoryPromotionsSetting,
  MemoryRedemptions,
  MemoryReviewQueue,
  MemoryThresholds,
  phase3Fakes,
} from '../../../../test/support/promotions-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { EventDelivery } from '../../../platform/events/event-delivery';
import type { AccessDecision } from '../../../platform/authz';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { QuoteRequest } from '../contracts/promotions.facade';
import { budgetMonthOf, summaryOf, type DiscountSummary } from '../domain/redemption';
import { LockContendedError } from './ports/promotion.repository';
import { ConfigPromotionsPolicy } from '../infrastructure/config-promotions-policy';
import { RedemptionFlashSales } from '../infrastructure/redemption-flash-sales';
import { PromotionsFacadeImplementation } from '../presentation/promotions.facade';
import type { PromotionsDependencies } from './promotions-dependencies';
import { CheckWasPrice } from './use-cases/check-was-price.use-case';
import { ConfirmRedemptions } from './use-cases/confirm-redemptions.use-case';
import { CreateOwnPromotion } from './use-cases/create-own-promotion.use-case';
import { CreatePromotion } from './use-cases/create-promotion.use-case';
import { GenerateBatchCodes } from './use-cases/generate-batch-codes.use-case';
import { QuoteDiscounts } from './use-cases/quote-discounts.use-case';
import { RedeemDiscounts } from './use-cases/redeem-discounts.use-case';
import { ReleaseCancelledRedemptions } from './use-cases/release-cancelled-redemptions.use-case';
import { SetFirstOrderSettings } from './use-cases/set-first-order-settings.use-case';
import { SetPromotionsStatus } from './use-cases/set-promotions-status.use-case';

// Package T2: the redemption of an order's discounts (in memory, both Market fixtures). The
// redemption writes exactly what the quote gave, or nothing and the fresh quote; it is idempotent
// per order; payment confirms it and cancellation gives back the counters, the budget, the
// first-order money and a single-use code; the per-customer and flash-sale limits count the
// redemptions that hold.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-25T10:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ADMIN = id<'Account'>(0xad);
const SELLER = id<'Seller'>(0x5e1);
const SELLER_ACCOUNT = id<'Account'>(0xa1);
const BUYER = id<'Account'>(0xb1);
const BUYER_2 = id<'Account'>(0xb2);
const BUYER_3 = id<'Account'>(0xb3);
const product = (n: number) => id<'Product'>(0x1000 + n);
const order = (n: number) => id<'Order'>(0x0de0 + n);

describe.each([['AU'], ['ZZ']] as const)('promotions redemption in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const rules = markets.get(market.marketId).promotions!;
  const policy = new ConfigPromotionsPolicy(markets);
  const settings = policy.settings(market)!;
  const currency = settings.currency;
  const DAY = { hours: 24 };

  let clock: FixedClock;
  let promotions: MemoryPromotions;
  let batchCodes: MemoryBatchCodes;
  let codeCrypto: FakeBatchCodeCrypto;
  let redemptions: MemoryRedemptions;
  let units: FakeUnitOfWork;
  let deps: PromotionsDependencies;
  let gate: ReturnType<typeof createUseCaseGate>;
  let events = 0;

  const admin = () =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ADMIN,
        sessionId: id<'Session'>(0x62),
        sellerId: null,
      }),
      'redeem-admin-abcdef',
    );
  const seller = () =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: SELLER_ACCOUNT,
        sessionId: id<'Session'>(0x63),
        sellerId: SELLER,
      }),
      'redeem-seller-abcdef',
    );
  const customer = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'customer',
      accountId: BUYER,
      sessionId: id<'Session'>(0x64),
      sellerId: null,
    }),
    'redeem-customer-abcdef',
  );
  const system = testCallContext(market, 'system', 'redeem-system-abcdef');
  const make = <U>(type: new (g: typeof gate, d: PromotionsDependencies) => U): U =>
    new type(gate, deps);
  const facade = () =>
    new PromotionsFacadeImplementation(
      make(QuoteDiscounts),
      make(RedeemDiscounts),
      make(CheckWasPrice),
      make(QuoteOwnDiscounts),
      make(RedeemOwnDiscounts),
      make(ListStaleRedemptions),
      make(SettleRedemptions),
    );
  const delivery = (): EventDelivery => ({
    eventId: id<'event'>(0xe000 + ++events),
    subscriber: 'promotions.test',
    attempt: 1,
  });

  beforeEach(async () => {
    clock = new FixedClock(T0);
    gate = createUseCaseGate(markets, {
      check: (): Promise<AccessDecision> => Promise.resolve({ allowed: true }),
    });
    promotions = new MemoryPromotions();
    batchCodes = new MemoryBatchCodes();
    codeCrypto = new FakeBatchCodeCrypto();
    redemptions = new MemoryRedemptions(promotions, batchCodes);
    units = new FakeUnitOfWork();
    const activity = new FakeSellerActivity();
    activity.since.set(SELLER, T0.subtract({ hours: 24 * 400 }));
    deps = {
      unitOfWork: units,
      promotions,
      optIns: new MemoryOptIns(),
      reviews: new MemoryReviewQueue(),
      settings: new MemoryPromotionsSetting(),
      firstOrder: new MemoryFirstOrder(),
      thresholds: new MemoryThresholds(),
      policy,
      batchCodes,
      codeCrypto,
      flashSales: new RedemptionFlashSales(units, redemptions),
      sellerActivity: activity,
      priceHistory: new FakePriceHistory(),
      sellerCommission: new FakeSellerCommission(),
      sellerCatalogue: new FakeSellerCatalogue(),
      ...phase3Fakes(),
      redemptions,
      stepUp: new FakeStepUp(() => clock.now()),
      audit: { record: () => Promise.resolve() },
      ids: new SequenceIdGenerator(clock),
      clock,
    };
    const on = await make(SetPromotionsStatus).execute(admin(), { status: 'active' });
    expect(on.ok).toBe(true);
  });

  const startsAt = () => T0.subtract(DAY).toString();
  const sale = (extra: Record<string, unknown> = {}) => ({
    type: 'SELLER_SALE',
    name: 'Spring sale',
    funding: 'SELLER',
    startsAt: startsAt(),
    reward: { kind: 'PERCENT', bps: 1000 },
    productIds: [product(1)],
    ...extra,
  });
  // Platform money in a Market whose tax ruling is open stays in test mode (and test orders).
  const platform = (extra: Record<string, unknown>) => ({
    funding: 'PLATFORM',
    startsAt: startsAt(),
    budgetMinor: '100000',
    testMode: !rules.gstRulingConfirmed,
    ...extra,
  });
  const line = (n: number, unitPrice: bigint, quantity: number) => ({
    id: `l${n}`,
    sellerId: SELLER,
    productId: product(n),
    unitPrice: money(unitPrice, currency),
    quantity,
  });
  const request = (
    lines: ReturnType<typeof line>[],
    extra: Partial<QuoteRequest> = {},
  ): QuoteRequest => ({
    lines,
    shipping: [],
    code: null,
    isFirstOrder: false,
    customerAccountId: BUYER,
    testMode: true,
    orderCommission: money(1_000_000n, currency),
    ...extra,
  });
  const quote = async (req: QuoteRequest) => {
    const result = await facade().quote(system, req);
    if (!result.ok) throw new Error(`quote failed: ${JSON.stringify(result.error)}`);
    return result.value;
  };
  const priced = async (orderId: Id<'Order'>, req: QuoteRequest, who = BUYER) => {
    const quoted = await quote(req);
    return {
      quoted,
      redeem: () =>
        facade().redeem(system, {
          orderId,
          customerAccountId: who,
          request: req,
          expected: summaryOf(quoted),
        }),
    };
  };
  const created = async (
    result: Promise<{ ok: true; value: { id: Id<'Promotion'> } } | { ok: false; error: unknown }>,
  ) => {
    const r = await result;
    if (!r.ok) throw new Error(`create failed: ${JSON.stringify(r.error)}`);
    return r.value;
  };
  const cancel = (orderId: Id<'Order'>, d = delivery()) =>
    make(ReleaseCancelledRedemptions).execute(system, { delivery: d, orderId });
  const pay = (orderId: Id<'Order'>, d = delivery()) =>
    make(ConfirmRedemptions).execute(system, { delivery: d, orderId });

  it('reserves exactly what the quote gave, with the counters, and a repeat writes nothing', async () => {
    const own = await created(make(CreateOwnPromotion).execute(seller(), sale()));
    const cart = request([line(1, 5000n, 2)], { testMode: false });
    const { quoted, redeem } = await priced(order(1), cart);
    expect(quoted.totals.goodsDiscount).toBe(1000n);

    expect(await redeem()).toEqual({ ok: true, value: { outcome: 'redeemed' } });
    expect(redemptions.discounts).toEqual([
      expect.objectContaining({
        orderId: order(1),
        promotionKey: own.id,
        promotionId: own.id,
        kind: 'PROMOTION',
        customerAccountId: BUYER,
        amount: 1000n,
        sellerShare: 1000n,
        platformShare: 0n,
        status: 'RESERVED',
        units: null,
        budgetMonth: null,
        codeHash: null,
      }),
    ]);
    expect(promotions.usage.get(own.id)).toEqual({
      usesCount: 1,
      spentMinor: 1000n,
      sellerShareMinor: 1000n,
      platformShareMinor: 0n,
    });

    expect(await redeem()).toEqual({ ok: true, value: { outcome: 'already-redeemed' } });
    expect(redemptions.discounts).toHaveLength(1);
    expect(promotions.usage.get(own.id)?.usesCount).toBe(1);
  });

  it('writes nothing for an order without a discount', async () => {
    const { redeem } = await priced(order(2), request([line(1, 5000n, 1)]));
    expect(await redeem()).toEqual({ ok: true, value: { outcome: 'nothing' } });
    expect(redemptions.discounts).toHaveLength(0);
  });

  it('answers the fresh quote and writes nothing when the discounts are not what the order holds', async () => {
    await created(make(CreateOwnPromotion).execute(seller(), sale()));
    const cart = request([line(1, 5000n, 1)], { testMode: false });
    const quoted = await quote(cart);
    const result = await facade().redeem(system, {
      orderId: order(3),
      customerAccountId: BUYER,
      request: cart,
      expected: {
        ...summaryOf(quoted),
        applied: summaryOf(quoted).applied.map((a) => ({ ...a, amount: a.amount + 1n })),
      },
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'promotions.quote-changed' } });
    if (!result.ok && result.error.code === 'promotions.quote-changed') {
      expect(result.error.quote.totals.goodsDiscount).toBe(500n);
    }
    expect(redemptions.discounts).toHaveLength(0);
  });

  it('refuses another customer than the one the request is for', async () => {
    await created(make(CreateOwnPromotion).execute(seller(), sale()));
    const cart = request([line(1, 5000n, 1)], { testMode: false });
    const quoted = await quote(cart);
    const result = await facade().redeem(system, {
      orderId: order(4),
      customerAccountId: BUYER_2,
      request: cart,
      expected: summaryOf(quoted),
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    expect(redemptions.discounts).toHaveLength(0);
  });

  it('is refused to anyone but the system actor', async () => {
    const cart = request([line(1, 5000n, 1)]);
    const result = await make(RedeemDiscounts).execute(customer, {
      orderId: order(5),
      customerAccountId: BUYER,
      request: cart,
      expected: summaryOf(await quote(cart)),
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'access.denied' } });
  });

  describe("checkout under the customer's own session", () => {
    const buyer2 = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'customer',
        accountId: BUYER_2,
        sessionId: id<'Session'>(0x65),
        sellerId: null,
      }),
      'redeem-customer2-abcdef',
    );

    it('quotes and redeems as the signed-in customer, for that customer only', async () => {
      const own = await created(make(CreateOwnPromotion).execute(seller(), sale()));
      // The customer is the session's: a request naming nobody is quoted for that account.
      const cart = request([line(1, 5000n, 2)], { testMode: false, customerAccountId: null });
      const quoted = await facade().quote(customer, cart);
      expect(quoted).toMatchObject({ ok: true, value: { totals: { goodsDiscount: 1000n } } });
      if (!quoted.ok) return;
      const redeemed = await facade().redeem(customer, {
        orderId: order(80),
        customerAccountId: BUYER,
        request: cart,
        expected: summaryOf(quoted.value),
      });
      expect(redeemed).toEqual({ ok: true, value: { outcome: 'redeemed' } });
      expect(redemptions.discounts).toEqual([
        expect.objectContaining({
          orderId: order(80),
          promotionId: own.id,
          customerAccountId: BUYER,
        }),
      ]);
    });

    it("refuses another customer's account, a test order, a seller or admin session and acting-as", async () => {
      await created(make(CreateOwnPromotion).execute(seller(), sale()));
      const cart = request([line(1, 5000n, 1)], { testMode: false });
      const expected = summaryOf(await quote(cart));
      const redeemAs = (context: typeof customer, customerAccountId: Id<'Account'>, req = cart) =>
        facade().redeem(context, { orderId: order(81), customerAccountId, request: req, expected });

      // The request is for BUYER: another customer can neither quote nor redeem it.
      expect(await facade().quote(buyer2, cart)).toMatchObject({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(await redeemAs(buyer2, BUYER)).toMatchObject({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(await redeemAs(buyer2, BUYER_2)).toMatchObject({
        ok: false,
        error: { code: 'access.denied' },
      });
      // A customer session never quotes or redeems a test order.
      const test = { ...cart, testMode: true };
      expect(await facade().quote(customer, test)).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
      expect(await redeemAs(customer, BUYER, test)).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
      // Only a customer: a seller or an admin session gets nothing.
      expect(await facade().quote(seller(), cart)).toMatchObject({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(await redeemAs(admin(), BUYER)).toMatchObject({
        ok: false,
        error: { code: 'access.denied' },
      });
      // Never an acting-as session, even one on the buyer's own account.
      const actingAs = {
        ...customer,
        actor: { ...customer.actor, actingAs: { adminAccountId: id<'Account'>(0xad) } },
      } as unknown as typeof customer;
      expect(await facade().quote(actingAs, cart)).toMatchObject({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(await redeemAs(actingAs, BUYER)).toMatchObject({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(redemptions.discounts).toHaveLength(0);
    });
  });

  describe('single-use codes', () => {
    it('lets one order claim a code; a second order racing for it gets the quote without it', async () => {
      const p = await created(
        make(CreatePromotion).execute(
          admin(),
          platform({
            type: 'BATCH_CODE',
            name: 'Newsletter',
            reward: { kind: 'FIXED', amountMinor: '500' },
          }),
        ),
      );
      const generated = await make(GenerateBatchCodes).execute(admin(), {
        promotionId: p.id,
        count: 1,
      });
      if (!generated.ok) throw new Error('generate failed');
      const [only] = generated.value.codes;
      const cart = (who: Id<'Account'>) =>
        request([line(1, 5000n, 1)], { code: only!, customerAccountId: who });
      // Both orders were priced while the code was free.
      const first = await priced(order(10), cart(BUYER));
      const second = await priced(order(11), cart(BUYER_2), BUYER_2);
      expect(first.quoted.code).toBe('APPLIED');
      expect(second.quoted.code).toBe('APPLIED');

      expect(await first.redeem()).toEqual({ ok: true, value: { outcome: 'redeemed' } });
      const hash = codeCrypto.hash(only!);
      expect(redemptions.discounts[0]).toMatchObject({
        codeHash: hash,
        amount: 500n,
        platformShare: 500n,
      });
      expect(batchCodes.rows.get(hash)?.usedAt).not.toBeNull();

      const lost = await second.redeem();
      expect(lost).toMatchObject({ ok: false, error: { code: 'promotions.quote-changed' } });
      if (!lost.ok && lost.error.code === 'promotions.quote-changed') {
        expect(lost.error.quote.code).toBe('NOT_APPLIED');
        expect(lost.error.quote.totals.goodsDiscount).toBe(0n);
      }
      expect(redemptions.discounts).toHaveLength(1);

      // The first order is cancelled: the code is free again and the counters are back to zero.
      expect(await cancel(order(10))).toEqual({ ok: true, value: { outcome: 'released' } });
      expect(batchCodes.rows.get(hash)?.usedAt).toBeNull();
      expect(promotions.usage.get(p.id)).toMatchObject({ usesCount: 0, spentMinor: 0n });
      const retry = await priced(order(12), cart(BUYER_2), BUYER_2);
      expect(retry.quoted.code).toBe('APPLIED');
      expect(await retry.redeem()).toEqual({ ok: true, value: { outcome: 'redeemed' } });
    });
  });

  describe('limits counted from redemptions', () => {
    it('holds a promotion to its uses per customer, and gives a use back on cancellation', async () => {
      const p = await created(
        make(CreatePromotion).execute(
          admin(),
          platform({
            type: 'CART_DISCOUNT',
            name: 'Once each',
            reward: { kind: 'PERCENT', bps: 500 },
            maxUsesPerCustomer: 1,
          }),
        ),
      );
      const cart = (who: Id<'Account'> | null) =>
        request([line(1, 5000n, 1)], { customerAccountId: who });
      const first = await priced(order(20), cart(BUYER));
      expect(first.quoted.totals.goodsDiscount).toBe(250n);
      expect((await first.redeem()).ok).toBe(true);

      // The same customer again: none. Another customer: yes. No customer: none (fail closed).
      expect((await quote(cart(BUYER))).totals.goodsDiscount).toBe(0n);
      expect((await quote(cart(BUYER_2))).totals.goodsDiscount).toBe(250n);
      expect((await quote(cart(null))).totals.goodsDiscount).toBe(0n);

      expect((await cancel(order(20))).ok).toBe(true);
      expect((await quote(cart(BUYER))).totals.goodsDiscount).toBe(250n);
      expect(promotions.usage.get(p.id)?.usesCount).toBe(0);
    });

    it('counts the units a flash sale sold, and gives them back on cancellation', async () => {
      const flash = await created(
        make(CreateOwnPromotion).execute(seller(), {
          type: 'FLASH_SALE',
          name: 'Tonight',
          funding: 'SELLER',
          reward: { kind: 'PERCENT', bps: 3000 },
          productIds: [product(1)],
          startsAt: T0.subtract(DAY).toString(),
          endsAt: T0.add(DAY).toString(),
          flash: { unitLimit: 5, timeZone: 'Australia/Brisbane' },
        }),
      );
      const three = await priced(order(30), request([line(1, 1000n, 3)], { testMode: false }));
      expect(three.quoted.totals.goodsDiscount).toBe(900n);
      expect((await three.redeem()).ok).toBe(true);
      expect(redemptions.discounts[0]).toMatchObject({ promotionId: flash.id, units: 3 });

      // Two units are left: a line of three gets the sale on two of them.
      const more = await quote(request([line(1, 1000n, 3)], { testMode: false }));
      expect(more.totals.goodsDiscount).toBe(600n);
      const two = await priced(order(31), request([line(1, 1000n, 3)], { testMode: false }));
      expect((await two.redeem()).ok).toBe(true);
      expect(redemptions.discounts[1]).toMatchObject({ units: 2 });
      expect(
        (await quote(request([line(1, 1000n, 1)], { testMode: false }))).totals.goodsDiscount,
      ).toBe(0n);

      expect((await cancel(order(30))).ok).toBe(true);
      expect(
        (await quote(request([line(1, 1000n, 3)], { testMode: false }))).totals.goodsDiscount,
      ).toBe(900n);
    });

    it('spends the first-order budget of the Market month and gives it back on cancellation', async () => {
      const saved = await make(SetFirstOrderSettings).execute(admin(), {
        enabled: true,
        kind: 'FIXED',
        amountMinor: '800',
        minSpendMinor: '3000',
        monthlyBudgetMinor: '1000',
      });
      expect(saved.ok).toBe(true);
      const cart = (who: Id<'Account'>) =>
        request([line(1, 5000n, 1)], { isFirstOrder: true, customerAccountId: who });
      const first = await priced(order(40), cart(BUYER));
      expect(first.quoted.totals.goodsDiscount).toBe(800n);
      expect((await first.redeem()).ok).toBe(true);
      expect(redemptions.discounts[0]).toMatchObject({
        kind: 'FIRST_ORDER',
        promotionKey: 'first-order',
        promotionId: null,
        budgetMonth: budgetMonthOf(T0, settings.timeZone),
      });
      expect(redemptions.marketLocked).toBe(1);
      // 200 of the month's 1 000 is left.
      expect((await quote(cart(BUYER_2))).totals.goodsDiscount).toBe(200n);
      expect((await cancel(order(40))).ok).toBe(true);
      expect((await quote(cart(BUYER_2))).totals.goodsDiscount).toBe(800n);
    });

    it('spends the budget of the month the order is redeemed in, in the Market zone', async () => {
      const saved = await make(SetFirstOrderSettings).execute(admin(), {
        enabled: true,
        kind: 'FIXED',
        amountMinor: '800',
        minSpendMinor: '3000',
        monthlyBudgetMinor: '1000',
      });
      expect(saved.ok).toBe(true);
      const cart = (who: Id<'Account'>) =>
        request([line(1, 5000n, 1)], { isFirstOrder: true, customerAccountId: who });
      // The last minute of October where the Market is (another instant in each fixture's zone).
      const lastMinute = Temporal.PlainDateTime.from('2026-10-31T23:59')
        .toZonedDateTime(settings.timeZone)
        .toInstant();
      clock.set(lastMinute);
      expect((await (await priced(order(44), cart(BUYER_2), BUYER_2)).redeem()).ok).toBe(true);
      expect(redemptions.discounts[0]).toMatchObject({ budgetMonth: '2026-10' });
      // October has 200 left; this order is priced in October and redeemed in November.
      const late = await priced(order(45), cart(BUYER));
      expect(late.quoted.totals.goodsDiscount).toBe(200n);
      clock.set(lastMinute.add({ minutes: 2 }));
      const redeemed = await late.redeem();
      // November's budget is whole again: the October price no longer holds.
      expect(redeemed).toMatchObject({ ok: false, error: { code: 'promotions.quote-changed' } });
      if (!redeemed.ok && redeemed.error.code === 'promotions.quote-changed') {
        expect(redeemed.error.quote.totals.goodsDiscount).toBe(800n);
      }
      const november = await priced(order(46), cart(BUYER));
      expect((await november.redeem()).ok).toBe(true);
      expect(redemptions.discounts[1]).toMatchObject({ budgetMonth: '2026-11', amount: 800n });
      // Releasing October's row gives back October's money, not November's.
      expect((await cancel(order(44))).ok).toBe(true);
      clock.set(lastMinute);
      expect((await quote(cart(BUYER_3))).totals.goodsDiscount).toBe(800n);
    });

    it('gives the first-order discount once per customer, even to two orders placed together', async () => {
      const saved = await make(SetFirstOrderSettings).execute(admin(), {
        enabled: true,
        kind: 'FIXED',
        amountMinor: '500',
        minSpendMinor: '1000',
        monthlyBudgetMinor: '100000',
      });
      expect(saved.ok).toBe(true);
      // Both orders were priced as the first (no paid order yet), before either was redeemed.
      const cart = request([line(1, 5000n, 1)], { isFirstOrder: true });
      const first = await priced(order(41), cart);
      const second = await priced(order(42), cart);
      expect(second.quoted.totals.goodsDiscount).toBe(500n);
      expect((await first.redeem()).ok).toBe(true);
      const late = await second.redeem();
      expect(late).toMatchObject({ ok: false, error: { code: 'promotions.quote-changed' } });
      if (!late.ok && late.error.code === 'promotions.quote-changed') {
        expect(late.error.quote.totals.goodsDiscount).toBe(0n);
      }
      // Once the first order is cancelled, the discount is the customer's again.
      expect((await cancel(order(41))).ok).toBe(true);
      expect((await (await priced(order(43), cart)).redeem()).ok).toBe(true);
    });
  });

  describe('payment and cancellation', () => {
    it('confirms on payment, once, and a later cancellation still gives back what was taken', async () => {
      const own = await created(make(CreateOwnPromotion).execute(seller(), sale()));
      const { redeem } = await priced(order(50), request([line(1, 5000n, 1)], { testMode: false }));
      expect((await redeem()).ok).toBe(true);

      const paid = delivery();
      expect(await pay(order(50), paid)).toEqual({ ok: true, value: { outcome: 'confirmed' } });
      expect(await pay(order(50), paid)).toEqual({
        ok: true,
        value: { outcome: 'already-handled' },
      });
      expect(redemptions.discounts[0]).toMatchObject({ status: 'CONFIRMED', confirmedAt: T0 });

      const cancelled = delivery();
      expect(await cancel(order(50), cancelled)).toEqual({
        ok: true,
        value: { outcome: 'released' },
      });
      expect(await cancel(order(50), cancelled)).toEqual({
        ok: true,
        value: { outcome: 'already-handled' },
      });
      // A new delivery of the same cancellation finds nothing left to give back.
      expect(await cancel(order(50))).toEqual({ ok: true, value: { outcome: 'nothing' } });
      expect(redemptions.discounts[0]).toMatchObject({
        status: 'RELEASED',
        releaseReason: 'ORDER_CANCELLED',
      });
      expect(promotions.usage.get(own.id)).toMatchObject({ usesCount: 0, spentMinor: 0n });

      // A released order is never redeemed again.
      const again = await priced(order(50), request([line(1, 5000n, 1)], { testMode: false }));
      expect(await again.redeem()).toEqual({
        ok: false,
        error: { code: 'promotions.redemption-released' },
      });
    });

    it('refuses to redeem an order whose cancellation came first, and never confirms it', async () => {
      await created(make(CreateOwnPromotion).execute(seller(), sale()));
      const { redeem } = await priced(order(51), request([line(1, 5000n, 1)], { testMode: false }));
      expect(await cancel(order(51))).toEqual({ ok: true, value: { outcome: 'nothing' } });
      expect(await redeem()).toEqual({
        ok: false,
        error: { code: 'promotions.redemption-released' },
      });
      expect(redemptions.discounts).toHaveLength(0);
      expect(await pay(order(51))).toEqual({ ok: true, value: { outcome: 'nothing' } });
    });

    it('answers a repeat with other discounts for the same order as a mismatch', async () => {
      await created(make(CreateOwnPromotion).execute(seller(), sale()));
      const cart = request([line(1, 5000n, 2)], { testMode: false });
      const { quoted, redeem } = await priced(order(52), cart);
      expect((await redeem()).ok).toBe(true);
      const summary = summaryOf(quoted);
      const other = await facade().redeem(system, {
        orderId: order(52),
        customerAccountId: BUYER,
        request: cart,
        expected: {
          ...summary,
          applied: summary.applied.map((a) => ({ ...a, amount: a.amount + 1n })),
        },
      });
      expect(other).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'expected', code: 'mismatch' }] },
      });
    });

    it('refuses an order with no expected summary, and answers nothing only when it took nothing', async () => {
      const cart = request([line(1, 5000n, 1)], { testMode: false });
      const missing = await facade().redeem(system, {
        orderId: order(53),
        customerAccountId: BUYER,
        request: cart,
        expected: undefined as unknown as DiscountSummary,
      });
      expect(missing).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      // Line discounts with no promotion behind them are not "nothing": they are compared.
      const lines = await facade().redeem(system, {
        orderId: order(53),
        customerAccountId: BUYER,
        request: cart,
        expected: {
          applied: [],
          lines: [{ lineId: 'l1', discount: 100n, sellerShare: 100n, platformShare: 0n }],
          shipping: [],
        },
      });
      expect(lines).toMatchObject({ ok: false, error: { code: 'promotions.quote-changed' } });
      expect(redemptions.discounts).toHaveLength(0);
    });

    it('answers conflict.retry and writes nothing when a lock cannot be taken', async () => {
      await created(make(CreateOwnPromotion).execute(seller(), sale()));
      const { redeem } = await priced(order(54), request([line(1, 5000n, 1)], { testMode: false }));
      const lockUsage = jest
        .spyOn(redemptions, 'lockUsage')
        .mockRejectedValueOnce(new LockContendedError('promotions.usage'));
      expect(await redeem()).toEqual({ ok: false, error: { code: 'conflict.retry' } });
      expect(redemptions.rows).toHaveLength(0);
      lockUsage.mockRestore();
      expect(await redeem()).toEqual({ ok: true, value: { outcome: 'redeemed' } });
    });

    it('confirms and releases whatever the switch says now', async () => {
      await created(make(CreateOwnPromotion).execute(seller(), sale()));
      const { redeem } = await priced(order(60), request([line(1, 5000n, 1)], { testMode: false }));
      expect((await redeem()).ok).toBe(true);
      expect((await make(SetPromotionsStatus).execute(admin(), { status: 'off' })).ok).toBe(true);
      expect(await pay(order(60))).toEqual({ ok: true, value: { outcome: 'confirmed' } });
      expect(await cancel(order(60))).toEqual({ ok: true, value: { outcome: 'released' } });
    });

    it('answers the bare cart when promotions were switched off after the order was priced', async () => {
      await created(make(CreateOwnPromotion).execute(seller(), sale()));
      const { redeem } = await priced(order(70), request([line(1, 5000n, 1)], { testMode: false }));
      expect((await make(SetPromotionsStatus).execute(admin(), { status: 'off' })).ok).toBe(true);
      const result = await redeem();
      expect(result).toMatchObject({ ok: false, error: { code: 'promotions.quote-changed' } });
      if (!result.ok && result.error.code === 'promotions.quote-changed') {
        expect(result.error.quote.enabled).toBe(false);
      }
      expect(redemptions.discounts).toHaveLength(0);
    });
  });

  describe("the safety sweep (ordering's settle-stale-redemptions)", () => {
    it('lists orders whose RESERVED redemptions are older than the instant, within the limit', async () => {
      await created(make(CreateOwnPromotion).execute(seller(), sale()));
      for (const n of [80, 81]) {
        const { redeem } = await priced(
          order(n),
          request([line(1, 5000n, 1)], { testMode: false }),
        );
        expect((await redeem()).ok).toBe(true);
      }
      expect(await pay(order(81))).toEqual({ ok: true, value: { outcome: 'confirmed' } });
      const later = T0.add({ hours: 2 });

      expect(await facade().staleRedemptions(system, { before: T0, limit: 10 })).toEqual({
        ok: true,
        value: [],
      });
      expect(await facade().staleRedemptions(system, { before: later, limit: 10 })).toEqual({
        ok: true,
        value: [order(80)],
      });
      // The next page starts after the last order id of the one before.
      expect(
        await facade().staleRedemptions(system, { before: later, limit: 10, after: order(80) }),
      ).toEqual({ ok: true, value: [] });
      expect(
        await facade().staleRedemptions(system, { before: later, limit: 10, after: order(79) }),
      ).toEqual({ ok: true, value: [order(80)] });
    });

    it('confirms a paid order and releases a cancelled one, once', async () => {
      await created(make(CreateOwnPromotion).execute(seller(), sale()));
      for (const n of [82, 83]) {
        const { redeem } = await priced(
          order(n),
          request([line(1, 5000n, 1)], { testMode: false }),
        );
        expect((await redeem()).ok).toBe(true);
      }
      const settle = (orderId: Id<'Order'>, outcome: 'paid' | 'cancelled') =>
        facade().settleRedemptions(system, { orderId, outcome });

      expect(await settle(order(82), 'paid')).toEqual({
        ok: true,
        value: { outcome: 'confirmed' },
      });
      expect(await settle(order(82), 'paid')).toEqual({ ok: true, value: { outcome: 'nothing' } });
      expect(await settle(order(83), 'cancelled')).toEqual({
        ok: true,
        value: { outcome: 'released' },
      });
      expect(await settle(order(83), 'cancelled')).toEqual({
        ok: true,
        value: { outcome: 'nothing' },
      });
      expect(redemptions.rows.map((r) => [r.orderId, r.status])).toEqual(
        expect.arrayContaining([
          [order(82), 'CONFIRMED'],
          [order(83), 'RELEASED'],
        ]),
      );
      expect(
        await facade().staleRedemptions(system, { before: T0.add({ hours: 2 }), limit: 10 }),
      ).toEqual({ ok: true, value: [] });
    });

    it('is system only, and refuses a bad request', async () => {
      const later = T0.add({ hours: 2 });
      expect(await facade().staleRedemptions(customer, { before: later, limit: 10 })).toMatchObject(
        { ok: false, error: { code: 'access.denied' } },
      );
      expect(
        await facade().settleRedemptions(customer, { orderId: order(84), outcome: 'cancelled' }),
      ).toMatchObject({ ok: false, error: { code: 'access.denied' } });
      expect(
        await facade().staleRedemptions(system, {
          before: later,
          limit: 10,
          after: 'not-an-id' as Id<'Order'>,
        }),
      ).toEqual({ ok: false, error: { code: 'validation.failed' } });
      for (const limit of [0, 101, 1.5]) {
        expect(await facade().staleRedemptions(system, { before: later, limit })).toEqual({
          ok: false,
          error: { code: 'validation.failed' },
        });
      }
      expect(
        await facade().settleRedemptions(system, {
          orderId: order(84),
          outcome: 'refunded' as 'paid',
        }),
      ).toEqual({ ok: false, error: { code: 'validation.failed' } });
    });
  });
});
