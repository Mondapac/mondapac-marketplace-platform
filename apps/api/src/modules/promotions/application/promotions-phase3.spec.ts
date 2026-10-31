import { money, parseId, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id } from '@mondapac/shared-kernel';
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
  FakeFlashSales,
  FakePriceHistory,
  FakeSellerActivity,
  FakeStepUp,
  MemoryBatchCodes,
  MemoryFirstOrder,
  MemoryOptIns,
  MemoryPromotions,
  MemoryPromotionsSetting,
  MemoryReviewQueue,
  MemoryThresholds,
  phase3Fakes,
} from '../../../../test/support/promotions-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { EventDelivery } from '../../../platform/events/event-delivery';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { AccessDecision } from '../../../platform/authz';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PROMOTIONS_AUDIT_ACTIONS } from '../domain/audit';
import { ConfigPromotionsPolicy } from '../infrastructure/config-promotions-policy';
import { PromotionsFacadeImplementation } from '../presentation/promotions.facade';
import type { PromotionsDependencies } from './promotions-dependencies';
import { ApplyReferralCode } from './use-cases/apply-referral-code.use-case';
import { CashbackOnDelivery } from './use-cases/cashback-on-delivery.use-case';
import { CheckWasPrice } from './use-cases/check-was-price.use-case';
import { CreateOwnPromotion } from './use-cases/create-own-promotion.use-case';
import { CreatePromotion } from './use-cases/create-promotion.use-case';
import { EditPromotion } from './use-cases/edit-promotion.use-case';
import { ListPromotionCredits } from './use-cases/list-promotion-credits.use-case';
import { PreviewQuote } from './use-cases/preview-quote.use-case';
import { QualifyReferralOnDelivery } from './use-cases/qualify-referral-on-delivery.use-case';
import { QuoteDiscounts } from './use-cases/quote-discounts.use-case';
import { SetPromotionBudget } from './use-cases/set-promotion-budget.use-case';
import { SetPromotionsStatus } from './use-cases/set-promotions-status.use-case';
import { ViewMyReferral } from './use-cases/view-my-referral.use-case';

// The phase 3 types through the use cases, in memory, on both Market fixtures (AU: platform money
// in test mode, GST ruling open; ZZ: ruling confirmed, other limits and alphabet): who may make
// what, the Market limits, the quote of the customer-group and store-follower offers with their
// fail-closed facts, the referral code and its abuse checks, and the wallet credit of cashback and
// referrals on delivery (idempotent per event and per source).

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-25T10:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ADMIN = id<'Account'>(0xad);
const SELLER = id<'Seller'>(0x5e1);
const SELLER_2 = id<'Seller'>(0x5e2);
const SELLER_ACCOUNT = id<'Account'>(0xa1);
const REFERRER = id<'Account'>(0xc1);
const NEWBIE = id<'Account'>(0xc2);
const NEWBIE_2 = id<'Account'>(0xc3);
const product = (n: number) => id<'Product'>(0x1000 + n);
const ACTIONS = new Set<string>(PROMOTIONS_AUDIT_ACTIONS.map((a) => a.action));

class RecordingAudit implements AuditWriter {
  readonly entries: AuditEntry[] = [];
  record(_context: CallContext, entry: AuditEntry): Promise<void> {
    if (!ACTIONS.has(entry.action)) throw new Error(`audit: unknown action ${entry.action}`);
    this.entries.push(entry);
    return Promise.resolve();
  }
}

describe.each([['AU'], ['ZZ']] as const)('promotions phase 3 types in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const policy = new ConfigPromotionsPolicy(markets);
  const rules = policy.settings(market)!.rules;
  const currency = policy.settings(market)!.currency;
  const DAY = { hours: 24 };
  const confirmed = rules.gstRulingConfirmed;

  let clock: FixedClock;
  let promotions: MemoryPromotions;
  let units: FakeUnitOfWork;
  let codeCrypto: FakeBatchCodeCrypto;
  let stepUp: FakeStepUp;
  let audit: RecordingAudit;
  let p3: ReturnType<typeof phase3Fakes>;
  let deps: PromotionsDependencies;
  let gate: ReturnType<typeof createUseCaseGate>;
  let eventCounter = 0;

  const admin = () =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ADMIN,
        sessionId: id<'Session'>(0x62),
        sellerId: null,
      }),
      'promo3-admin-abcdef',
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
      'promo3-seller-abcdef',
    );
  const customerOf = (accountId: Id<'Account'>) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'customer',
        accountId,
        sessionId: id<'Session'>(0x64),
        sellerId: null,
      }),
      'promo3-customer-abcdef',
    );
  const system = testCallContext(market, 'system', 'promo3-system-abcdef');
  const actingAs = (context: CallContext) =>
    ({
      ...context,
      actor: { ...context.actor, actingAs: { adminAccountId: ADMIN } },
    }) as unknown as CallContext;
  const make = <U>(type: new (g: typeof gate, d: PromotionsDependencies) => U): U =>
    new type(gate, deps);
  const facade = () =>
    new PromotionsFacadeImplementation(make(QuoteDiscounts), make(CheckWasPrice));

  beforeEach(async () => {
    clock = new FixedClock(T0);
    gate = createUseCaseGate(markets, {
      check: (): Promise<AccessDecision> => Promise.resolve({ allowed: true }),
    });
    promotions = new MemoryPromotions();
    codeCrypto = new FakeBatchCodeCrypto();
    stepUp = new FakeStepUp(() => clock.now());
    audit = new RecordingAudit();
    units = new FakeUnitOfWork();
    p3 = phase3Fakes();
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
      batchCodes: new MemoryBatchCodes(),
      codeCrypto,
      flashSales: new FakeFlashSales(),
      sellerActivity: activity,
      priceHistory: new FakePriceHistory(),
      ...p3,
      stepUp,
      audit,
      ids: new SequenceIdGenerator(clock),
      clock,
    };
    const on = await make(SetPromotionsStatus).execute(admin(), { status: 'active' });
    expect(on.ok).toBe(true);
    audit.entries.length = 0;
  });

  const startsAt = () => T0.subtract(DAY).toString();
  // Platform money in a Market whose tax ruling is open stays in test mode.
  const platform = (extra: Record<string, unknown>) => ({
    funding: 'PLATFORM',
    startsAt: startsAt(),
    budgetMinor: '100000',
    testMode: !confirmed,
    ...extra,
  });
  const group = (extra: Record<string, unknown> = {}) =>
    platform({
      type: 'CUSTOMER_GROUP',
      name: 'Welcome back',
      reward: { kind: 'PERCENT', bps: 1000 },
      segment: { kind: 'RETURNING_CUSTOMER', minDaysSinceLastOrder: 60 },
      ...extra,
    });
  const follower = (extra: Record<string, unknown> = {}) => ({
    type: 'STORE_FOLLOWER',
    name: 'For followers',
    funding: 'SELLER',
    startsAt: startsAt(),
    reward: { kind: 'PERCENT', bps: 1000 },
    ...extra,
  });
  const referral = (extra: Record<string, unknown> = {}) =>
    platform({
      type: 'REFERRAL',
      name: 'Refer a friend',
      reward: { kind: 'FIXED', amountMinor: '1000' },
      refereeRewardMinor: '800',
      maxUsesPerCustomer: 2,
      ...extra,
    });
  const cashback = (extra: Record<string, unknown> = {}) =>
    platform({
      type: 'CASHBACK',
      name: 'Cashback',
      reward: { kind: 'PERCENT', bps: 500 },
      capMinor: '2000',
      ...extra,
    });
  const line = (n: number, unitPrice: bigint, quantity: number, sellerId = SELLER) => ({
    id: `l${n}`,
    sellerId,
    productId: product(n),
    unitPrice: money(unitPrice, currency),
    quantity,
  });
  const request = (lines: ReturnType<typeof line>[], extra: Record<string, unknown> = {}) => ({
    lines,
    shipping: [] as {
      id: string;
      sellerId: Id<'Seller'> | null;
      zoneCode: string;
      amount: ReturnType<typeof money>;
    }[],
    code: null as string | null,
    isFirstOrder: false,
    customerAccountId: REFERRER as Id<'Account'> | null,
    testMode: true,
    orderCommission: money(1_000_000n, currency),
    ...extra,
  });
  const quote = async (req: ReturnType<typeof request>) => {
    const result = await facade().quote(system, req);
    if (!result.ok) throw new Error(`quote failed: ${JSON.stringify(result.error)}`);
    return result.value;
  };
  const created = async <V extends { id: Id<'Promotion'> }>(
    result: Promise<{ ok: true; value: V } | { ok: false; error: unknown }>,
  ) => {
    const r = await result;
    if (!r.ok) throw new Error(`create failed: ${JSON.stringify(r.error)}`);
    return r.value;
  };
  const adminCreate = (body: Record<string, unknown>) =>
    created(make(CreatePromotion).execute(admin(), body));
  const sellerCreate = (body: Record<string, unknown>) =>
    created(make(CreateOwnPromotion).execute(seller(), body));
  const fields = (result: { ok: boolean; error?: unknown }) =>
    !result.ok &&
    result.error !== null &&
    typeof result.error === 'object' &&
    'fields' in result.error
      ? (result.error.fields as { path: string; code: string }[]).map((f) => `${f.path}:${f.code}`)
      : [];

  describe('who may make which type', () => {
    it('lets an admin make the platform types and a seller the follower offer only', async () => {
      for (const body of [group(), referral(), cashback()]) {
        expect((await make(CreatePromotion).execute(admin(), body)).ok).toBe(true);
      }
      expect((await make(CreateOwnPromotion).execute(seller(), follower())).ok).toBe(true);

      for (const body of [
        group({ funding: 'SELLER', budgetMinor: undefined, testMode: false }),
        referral({ funding: 'SELLER', budgetMinor: undefined, testMode: false }),
        cashback({ funding: 'SELLER', budgetMinor: undefined, testMode: false }),
      ]) {
        const result = await make(CreateOwnPromotion).execute(seller(), body);
        expect(fields(result)).toContain('type:not-allowed');
      }
      const wrong = await make(CreatePromotion).execute(admin(), follower());
      expect(fields(wrong)).toContain('type:not-allowed');
    });

    it('refuses a customer, an anonymous call and an acting-as session', async () => {
      const as = (context: CallContext) => make(CreatePromotion).execute(context, referral());
      expect(await as(actingAs(admin()))).toMatchObject({ ok: false });
      const customerResult = await as(customerOf(REFERRER));
      expect(customerResult).toMatchObject({ ok: false });
      expect(promotions.records.size).toBe(0);
    });

    it('refuses every write while the Market switch is off', async () => {
      await make(SetPromotionsStatus).execute(admin(), { status: 'off' });
      for (const body of [group(), referral(), cashback()]) {
        expect(await make(CreatePromotion).execute(admin(), body)).toEqual({
          ok: false,
          error: { code: 'promotions.disabled' },
        });
      }
      expect(await make(CreateOwnPromotion).execute(seller(), follower())).toEqual({
        ok: false,
        error: { code: 'promotions.disabled' },
      });
    });

    it('audits a creation without the code or any customer data', async () => {
      await adminCreate(referral());
      const entry = audit.entries.at(-1)!;
      expect(entry.action).toBe('promotions.promotion.created');
      expect(entry.after).toMatchObject({ type: 'referral', funding: 'platform' });
      expect(
        JSON.stringify(entry, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
      ).not.toMatch(/accountId|segment/);
    });
  });

  describe('the Market limits and the tax-ruling gate', () => {
    it('keeps a referral and a cashback inside the Market limits', async () => {
      const referralRules = rules.referral!;
      const cashbackRules = rules.cashback!;
      expect(
        fields(
          await make(CreatePromotion).execute(
            admin(),
            referral({
              reward: {
                kind: 'FIXED',
                amountMinor: (referralRules.maxRewardMinor + 1n).toString(),
              },
            }),
          ),
        ),
      ).toContain('reward.amountMinor:exceeds-market-limit');
      expect(
        fields(
          await make(CreatePromotion).execute(
            admin(),
            referral({ maxUsesPerCustomer: referralRules.maxRewardedPerReferrer + 1 }),
          ),
        ),
      ).toContain('maxUsesPerCustomer:exceeds-market-limit');
      expect(
        fields(
          await make(CreatePromotion).execute(
            admin(),
            cashback({ reward: { kind: 'PERCENT', bps: cashbackRules.maxBps + 1 } }),
          ),
        ),
      ).toContain('reward.bps:exceeds-market-limit');
      expect(
        fields(
          await make(CreatePromotion).execute(
            admin(),
            cashback({ capMinor: (cashbackRules.maxCapMinor + 1n).toString() }),
          ),
        ),
      ).toContain('capMinor:exceeds-market-limit');
    });

    it('needs test mode for platform credit until the Market’s ruling is confirmed', async () => {
      const result = await make(CreatePromotion).execute(admin(), referral({ testMode: false }));
      if (confirmed) expect(result.ok).toBe(true);
      else expect(fields(result)).toContain('testMode:required');
    });

    it('fills the Market’s default days of a returning-customer segment', async () => {
      const made = await adminCreate(group({ segment: { kind: 'RETURNING_CUSTOMER' } }));
      expect(promotions.records.get(made.id)!.segmentMinDays).toBe(
        rules.customerGroupReturningDays,
      );
    });

    it('asks a fresh two-step code for a platform budget above the Market amount', async () => {
      const above = (rules.platformBudgetStepUpMinor + 1n).toString();
      const refused = await make(CreatePromotion).execute(
        admin(),
        referral({ budgetMinor: above }),
      );
      expect(refused).toMatchObject({ ok: false, error: { code: 'second-factor.required' } });
      expect(promotions.records.size).toBe(0);
      stepUp.fresh = true;
      const made = await make(CreatePromotion).execute(admin(), referral({ budgetMinor: above }));
      expect(made.ok).toBe(true);
      expect(stepUp.spent).toEqual(['promotions.platform-funding.approve']);
    });

    it('does not let the budget fall below the credits already reserved', async () => {
      const made = await adminCreate(cashback({ budgetMinor: '5000' }));
      await p3.credits.insert(market, {
        id: id<'PromotionCredit'>(0xc00),
        promotionId: made.id,
        kind: 'CASHBACK',
        recipientAccountId: REFERRER,
        orderId: id<'Order'>(0x0d1),
        sourceKind: 'SELLER_ORDER',
        sourceId: id<'SellerOrder'>(0x501),
        amountMinor: 1200n,
        currency,
        status: 'GRANTED',
        failureCode: null,
        walletJournalId: 'j',
        idempotencyKey: 'promotions:cashback:x1',
        createdAt: T0,
        settledAt: T0,
      });
      const low = await make(SetPromotionBudget).execute(admin(), {
        promotionId: made.id,
        budgetMinor: '1000',
      });
      expect(fields(low)).toContain('budgetMinor:below-spent');
      const ok = await make(SetPromotionBudget).execute(admin(), {
        promotionId: made.id,
        budgetMinor: '1200',
      });
      expect(ok.ok).toBe(true);
    });

    it('edits a referral’s terms inside the same limits', async () => {
      const made = await adminCreate(referral());
      const over = (rules.referral!.maxRewardMinor + 1n).toString();
      const bad = await make(EditPromotion).execute(admin(), {
        ...referral({ refereeRewardMinor: over }),
        promotionId: made.id,
      });
      expect(fields(bad)).toContain('refereeRewardMinor:exceeds-market-limit');
    });
  });

  describe('customer-group discount', () => {
    const cart = () => request([line(1, 10000n, 1)]);

    it('applies to a returning customer whose last order was long enough ago', async () => {
      await adminCreate(group());
      p3.orderHistory.lastOrder.set(REFERRER, T0.subtract({ hours: 24 * 90 }));
      expect((await quote(cart())).totals.goodsDiscount).toBe(1000n);
      p3.orderHistory.lastOrder.set(REFERRER, T0.subtract({ hours: 24 * 60 }));
      expect((await quote(cart())).totals.goodsDiscount).toBe(1000n);
      p3.orderHistory.lastOrder.set(REFERRER, T0.subtract({ hours: 24 * 59 }));
      expect((await quote(cart())).totals.goodsDiscount).toBe(0n);
    });

    it('is not offered when the history is unknown, unreadable, empty or there is no customer', async () => {
      await adminCreate(group());
      expect((await quote(cart())).totals.goodsDiscount).toBe(0n);
      p3.orderHistory.lastOrder.set(REFERRER, T0.subtract({ hours: 24 * 90 }));
      p3.orderHistory.throws = true;
      expect((await quote(cart())).totals.goodsDiscount).toBe(0n);
      p3.orderHistory.throws = false;
      p3.orderHistory.broken = true;
      expect((await quote(cart())).totals.goodsDiscount).toBe(0n);
      p3.orderHistory.broken = false;
      expect(
        (await quote(request([line(1, 10000n, 1)], { customerAccountId: null }))).totals
          .goodsDiscount,
      ).toBe(0n);
      p3.orderHistory.lastOrder.set(REFERRER, null);
      expect((await quote(cart())).totals.goodsDiscount).toBe(0n);
    });

    it('reads nothing when no customer-group promotion is live', async () => {
      await quote(cart());
      expect(p3.orderHistory.reads).toBe(0);
      expect(p3.storeFollows.reads).toBe(0);
    });

    it('applies to a delivery zone segment without asking for any history', async () => {
      await adminCreate(
        group({
          segment: { kind: 'DELIVERY_ZONE' },
          zones: ['BRIS-1'],
          reward: { kind: 'PERCENT', bps: 500 },
        }),
      );
      const shipping = (zoneCode: string) => [
        { id: 's1', sellerId: SELLER, zoneCode, amount: money(500n, currency) },
      ];
      expect(
        (await quote(request([line(1, 10000n, 1)], { shipping: shipping('BRIS-1') }))).totals
          .goodsDiscount,
      ).toBe(500n);
      expect(
        (await quote(request([line(1, 10000n, 1)], { shipping: shipping('SYD-1') }))).totals
          .goodsDiscount,
      ).toBe(0n);
      expect(p3.orderHistory.reads).toBe(0);
    });

    it('a paused or test-mode-only promotion does not reach a real order', async () => {
      await adminCreate(group());
      p3.orderHistory.lastOrder.set(REFERRER, T0.subtract({ hours: 24 * 90 }));
      const real = await quote(request([line(1, 10000n, 1)], { testMode: false }));
      expect(real.totals.goodsDiscount).toBe(confirmed ? 1000n : 0n);
    });

    it('lets an admin preview a stated customer without reading any module', async () => {
      await adminCreate(group());
      const result = await make(PreviewQuote).execute(admin(), {
        lines: [
          {
            id: 'l1',
            productId: product(1),
            sellerId: SELLER,
            unitPriceMinor: '10000',
            quantity: 1,
          },
        ],
        orderCommissionMinor: '100000',
        customer: { daysSinceLastOrder: 90 },
      });
      expect(result.ok && result.value.totals.goodsDiscount).toBe(1000n);
      expect(p3.orderHistory.reads).toBe(0);
      const bad = await make(PreviewQuote).execute(admin(), {
        lines: [
          {
            id: 'l1',
            productId: product(1),
            sellerId: SELLER,
            unitPriceMinor: '10000',
            quantity: 1,
          },
        ],
        orderCommissionMinor: '100000',
        customer: { daysSinceLastOrder: -3 },
      });
      expect(fields(bad)).toContain('customer.daysSinceLastOrder:value');
    });
  });

  describe('store-follower offer', () => {
    it('applies to the followed seller’s lines only', async () => {
      await sellerCreate(follower());
      p3.storeFollows.follows.set(REFERRER, [SELLER]);
      const out = await quote(request([line(1, 10000n, 1), line(2, 10000n, 1, SELLER_2)]));
      expect(out.totals.goodsDiscount).toBe(1000n);
      expect(out.totals.sellerShare).toBe(1000n);
      expect(out.totals.platformShare).toBe(0n);
    });

    it('is not offered to a customer who does not follow, or when follows are unknown', async () => {
      await sellerCreate(follower());
      expect((await quote(request([line(1, 10000n, 1)]))).totals.goodsDiscount).toBe(0n);
      p3.storeFollows.follows.set(REFERRER, []);
      expect((await quote(request([line(1, 10000n, 1)]))).totals.goodsDiscount).toBe(0n);
      p3.storeFollows.follows.set(REFERRER, [SELLER]);
      p3.storeFollows.throws = true;
      expect((await quote(request([line(1, 10000n, 1)]))).totals.goodsDiscount).toBe(0n);
      p3.storeFollows.throws = false;
      p3.storeFollows.broken = true;
      expect((await quote(request([line(1, 10000n, 1)]))).totals.goodsDiscount).toBe(0n);
    });
  });

  describe('my referral code', () => {
    it('is unguessable per customer, stable, and in the Market alphabet and length', async () => {
      await adminCreate(referral());
      const mine = await make(ViewMyReferral).execute(customerOf(REFERRER), {});
      const again = await make(ViewMyReferral).execute(customerOf(REFERRER), {});
      const other = await make(ViewMyReferral).execute(customerOf(NEWBIE), {});
      if (!mine.ok || !again.ok || !other.ok) throw new Error('view failed');
      expect(mine.value.code).toBe(again.value.code);
      expect(mine.value.code).not.toBe(other.value.code);
      expect(mine.value.code).toHaveLength(rules.referral!.codeLength);
      expect([...mine.value.code].every((ch) => rules.referral!.alphabet.includes(ch))).toBe(true);
      expect(mine.value).toMatchObject({
        referrerRewardMinor: 1000n,
        refereeRewardMinor: 800n,
        currency,
        maxRewarded: 2,
        pending: 0,
        qualified: 0,
      });
      // Only the hash is stored.
      const stored = [...p3.referrals.codes.values()].map((c) => c.codeHash);
      expect(stored).toHaveLength(2);
      expect(stored).not.toContain(mine.value.code);
    });

    it('is not found without a live program, unavailable without the pepper, and for customers only', async () => {
      expect(await make(ViewMyReferral).execute(customerOf(REFERRER), {})).toEqual({
        ok: false,
        error: { code: 'promotions.not-found' },
      });
      await adminCreate(referral());
      codeCrypto.available = false;
      expect(await make(ViewMyReferral).execute(customerOf(REFERRER), {})).toEqual({
        ok: false,
        error: { code: 'promotions.unavailable' },
      });
      codeCrypto.available = true;
      expect(await make(ViewMyReferral).execute(admin(), {})).toMatchObject({ ok: false });
      expect(
        await make(ViewMyReferral).execute(
          testCallContext(market, 'anonymous', 'promo3-anon-abcdef'),
          {},
        ),
      ).toMatchObject({ ok: false });
    });
  });

  describe('applying a referral code', () => {
    let referrerCode: string;
    beforeEach(async () => {
      await adminCreate(referral());
      const mine = await make(ViewMyReferral).execute(customerOf(REFERRER), {});
      if (!mine.ok) throw new Error('view failed');
      referrerCode = mine.value.code;
      p3.orderHistory.lastOrder.set(NEWBIE, null);
      p3.orderHistory.lastOrder.set(NEWBIE_2, null);
    });
    const apply = (who: Id<'Account'>, text: unknown) =>
      make(ApplyReferralCode).execute(customerOf(who), { code: text });

    it('records a pending referral that expires after the Market’s window', async () => {
      const result = await apply(NEWBIE, referrerCode);
      expect(result).toEqual({
        ok: true,
        value: {
          status: 'PENDING',
          expiresAt: T0.add({ hours: 24 * rules.referral!.qualifyWithinDays }),
        },
      });
      expect([...p3.referrals.rows.values()]).toHaveLength(1);
      // Typed in lower case with spaces around.
      expect((await apply(NEWBIE_2, ` ${referrerCode.toLowerCase()} `)).ok).toBe(true);
    });

    it('refuses the own code, a second referral and a customer who ordered before, with one answer', async () => {
      const notEligible = { ok: false, error: { code: 'promotions.referral-not-eligible' } };
      p3.orderHistory.lastOrder.set(REFERRER, null);
      expect(await apply(REFERRER, referrerCode)).toEqual(notEligible);
      expect((await apply(NEWBIE, referrerCode)).ok).toBe(true);
      expect(await apply(NEWBIE, referrerCode)).toEqual(notEligible);
      p3.orderHistory.lastOrder.set(NEWBIE_2, T0.subtract({ hours: 24 * 400 }));
      expect(await apply(NEWBIE_2, referrerCode)).toEqual(notEligible);
    });

    it('refuses when the order history cannot be read (fail closed)', async () => {
      p3.orderHistory.broken = true;
      expect(await apply(NEWBIE, referrerCode)).toEqual({
        ok: false,
        error: { code: 'promotions.referral-not-eligible' },
      });
      expect(p3.referrals.rows.size).toBe(0);
    });

    it('answers not-found for an unknown, malformed or foreign-alphabet code, never saying which exist', async () => {
      const notFound = { ok: false, error: { code: 'promotions.not-found' } };
      const other = [...referrerCode].reverse().join('');
      expect(
        await apply(NEWBIE, other === referrerCode ? 'A'.repeat(referrerCode.length) : other),
      ).toEqual(notFound);
      expect(await apply(NEWBIE, 'SHORT')).toEqual(notFound);
      expect(await apply(NEWBIE, '!'.repeat(referrerCode.length))).toEqual(notFound);
      expect(fields(await apply(NEWBIE, ''))).toContain('code:value');
      expect(fields(await apply(NEWBIE, 42))).toContain('code:value');
      expect(p3.referrals.rows.size).toBe(0);
    });

    it('is refused for a staff session and while the switch is off', async () => {
      expect(await make(ApplyReferralCode).execute(admin(), { code: referrerCode })).toMatchObject({
        ok: false,
      });
      await make(SetPromotionsStatus).execute(admin(), { status: 'off' });
      expect(await apply(NEWBIE, referrerCode)).toEqual({
        ok: false,
        error: { code: 'promotions.disabled' },
      });
    });
  });

  // ---- credits after delivery ----------------------------------------------------------------

  const delivery = (): EventDelivery => ({
    eventId: id<'event'>(0xe000 + ++eventCounter),
    subscriber: 'promotions.test',
    attempt: 1,
  });
  const deliverOrder = (
    n: number,
    who: Id<'Account'>,
    goodsMinor: bigint,
    over: {
      placedAt?: Temporal.Instant;
      testOrder?: boolean;
      orderId?: Id<'Order'>;
      goodsCurrency?: string;
    } = {},
  ) => {
    const facts = {
      orderId: over.orderId ?? id<'Order'>(0x0d00 + n),
      sellerOrderId: id<'SellerOrder'>(0x5000 + n),
      customerAccountId: who,
      goodsPaid: money(goodsMinor, over.goodsCurrency ?? currency),
      placedAt: over.placedAt ?? T0.add({ hours: 1 }),
      deliveredAt: T0.add({ hours: 48 }),
      testOrder: over.testOrder ?? false,
    };
    p3.orderFacts.add(facts);
    return facts;
  };
  const input = (
    facts: { orderId: Id<'Order'>; sellerOrderId: Id<'SellerOrder'> },
    d = delivery(),
  ) => ({
    delivery: d,
    orderId: facts.orderId,
    sellerOrderId: facts.sellerOrderId,
  });
  const credits = () => [...p3.credits.rows.values()];

  describe('cashback on delivery', () => {
    const run = (facts: Parameters<typeof input>[0], d?: EventDelivery) =>
      make(CashbackOnDelivery).execute(system, input(facts, d));

    it('credits the percent of the goods paid to the wallet once, with a stable key', async () => {
      await adminCreate(cashback({ testMode: !confirmed }));
      const facts = deliverOrder(1, REFERRER, 10000n);
      const first = delivery();
      const result = await run(facts, first);
      if (confirmed) {
        expect(result).toEqual({ ok: true, value: { outcome: 'issued' } });
        expect(p3.walletCredit.grants).toHaveLength(1);
        expect(p3.walletCredit.grants[0]).toMatchObject({
          accountId: REFERRER,
          amount: money(500n, currency),
          orderId: facts.orderId,
        });
        expect(credits()[0]).toMatchObject({
          status: 'GRANTED',
          amountMinor: 500n,
          kind: 'CASHBACK',
        });
      } else {
        // A test-mode promotion only records the intended credit.
        expect(result).toEqual({ ok: true, value: { outcome: 'recorded' } });
        expect(p3.walletCredit.grants).toHaveLength(0);
        expect(credits()[0]).toMatchObject({ status: 'RECORDED', amountMinor: 500n });
      }
    });

    it('the same event twice, and a new event for the same order, make one credit', async () => {
      await adminCreate(cashback());
      const facts = deliverOrder(1, REFERRER, 10000n);
      const d = delivery();
      await run(facts, d);
      expect(await run(facts, d)).toEqual({ ok: true, value: { outcome: 'already-handled' } });
      await run(facts);
      expect(credits()).toHaveLength(1);
      expect(p3.walletCredit.grants.length).toBe(confirmed ? 1 : 0);
    });

    it('stops at the promotion’s per-order cap, across the seller orders of one order', async () => {
      await adminCreate(cashback({ capMinor: '700' }));
      const order = id<'Order'>(0x0dff);
      const a = deliverOrder(1, REFERRER, 10000n, { orderId: order });
      const b = deliverOrder(2, REFERRER, 10000n, { orderId: order });
      await run(a);
      await run(b);
      expect(
        credits()
          .map((c) => c.amountMinor)
          .sort(),
      ).toEqual([200n, 500n]);
    });

    it('stops at the budget and at the minimum spend, and counts the per-customer limit', async () => {
      const made = await adminCreate(
        cashback({ budgetMinor: '600', minSpendMinor: '2000', maxUsesPerCustomer: 2 }),
      );
      await run(deliverOrder(1, REFERRER, 1000n));
      expect(credits()).toHaveLength(0);
      await run(deliverOrder(2, REFERRER, 10000n));
      await run(deliverOrder(3, REFERRER, 10000n));
      await run(deliverOrder(4, REFERRER, 10000n));
      if (confirmed) {
        expect(credits().map((c) => c.amountMinor)).toEqual([500n, 100n]);
        expect(await p3.credits.reservedTotal(market, made.id)).toBe(600n);
      } else {
        // A test-mode promotion only records: it holds no budget and counts no use.
        expect(credits().map((c) => [c.status, c.amountMinor])).toEqual([
          ['RECORDED', 500n],
          ['RECORDED', 500n],
          ['RECORDED', 500n],
        ]);
        expect(await p3.credits.reservedTotal(market, made.id)).toBe(0n);
      }
    });

    it('pays the larger of two live cashbacks, not both', async () => {
      await adminCreate(cashback({ name: 'Small', reward: { kind: 'PERCENT', bps: 200 } }));
      await adminCreate(cashback({ name: 'Large', reward: { kind: 'PERCENT', bps: 400 } }));
      await run(deliverOrder(1, REFERRER, 10000n));
      expect(credits().map((c) => c.amountMinor)).toEqual([400n]);
    });

    it('does nothing, and reads no order fact, with no live cashback or with the switch off', async () => {
      const facts = deliverOrder(1, REFERRER, 10000n);
      expect(await run(facts)).toEqual({ ok: true, value: { outcome: 'nothing' } });
      expect(p3.orderFacts.reads).toBe(0);
      await adminCreate(cashback());
      await make(SetPromotionsStatus).execute(admin(), { status: 'off' });
      expect(await run(facts)).toEqual({ ok: true, value: { outcome: 'nothing' } });
      expect(credits()).toHaveLength(0);
    });

    it('retries when the order facts are unknown, never guessing an amount', async () => {
      await adminCreate(cashback());
      const unknown = { orderId: id<'Order'>(0x0d99), sellerOrderId: id<'SellerOrder'>(0x5099) };
      expect(await run(unknown)).toEqual({ ok: false, error: { code: 'promotions.try-again' } });
      expect(credits()).toHaveLength(0);
    });

    it('ignores a delivery in another currency, and rejects malformed ids', async () => {
      await adminCreate(cashback());
      const foreign = deliverOrder(1, REFERRER, 10000n, {
        goodsCurrency: currency === 'USD' ? 'EUR' : 'USD',
      });
      expect(await run(foreign)).toEqual({ ok: true, value: { outcome: 'nothing' } });
      expect(
        await make(CashbackOnDelivery).execute(system, {
          delivery: delivery(),
          orderId: 'x',
          sellerOrderId: 5,
        }),
      ).toEqual({ ok: false, error: { code: 'validation.failed' } });
    });

    if (confirmed) {
      it('earns nothing on a test order', async () => {
        await adminCreate(cashback({ testMode: false }));
        await run(deliverOrder(1, REFERRER, 10000n, { testOrder: true }));
        expect(credits()).toHaveLength(0);
      });

      it('keeps the credit pending when the wallet is not available, and finishes it on the retry with the same key', async () => {
        await adminCreate(cashback({ testMode: false }));
        const facts = deliverOrder(1, REFERRER, 10000n);
        p3.walletCredit.failure = { retry: true, code: 'wallet.unavailable' };
        expect(await run(facts)).toEqual({ ok: false, error: { code: 'promotions.try-again' } });
        expect(credits()[0]!.status).toBe('PENDING');
        const key = credits()[0]!.idempotencyKey;
        expect(await run(facts)).toEqual({ ok: true, value: { outcome: 'issued' } });
        expect(credits()).toHaveLength(1);
        expect(credits()[0]).toMatchObject({ status: 'GRANTED', idempotencyKey: key });
        expect(p3.walletCredit.grants).toHaveLength(1);
      });

      it('marks the credit failed when the wallet refuses for good, and does not retry it', async () => {
        await adminCreate(cashback({ testMode: false }));
        const facts = deliverOrder(1, REFERRER, 10000n);
        p3.walletCredit.failure = { retry: false, code: 'wallet.account-not-active' };
        expect(await run(facts)).toEqual({ ok: true, value: { outcome: 'failed' } });
        expect(credits()[0]).toMatchObject({
          status: 'FAILED',
          failureCode: 'wallet.account-not-active',
        });
        // A failed credit no longer holds budget.
        expect(await p3.credits.reservedTotal(market, credits()[0]!.promotionId)).toBe(0n);
      });
    } else {
      it('earns nothing from a real promotion while the tax ruling is open (skipped, not recorded)', async () => {
        const made = await adminCreate(cashback());
        promotions.records.set(made.id, { ...promotions.records.get(made.id)!, testMode: false });
        await run(deliverOrder(1, REFERRER, 10000n));
        expect(credits()).toHaveLength(0);
        expect(p3.walletCredit.grants).toHaveLength(0);
      });
    }
  });

  describe('referral reward on delivery', () => {
    let referrerCode: string;
    const qualify = (facts: Parameters<typeof input>[0], d?: EventDelivery) =>
      make(QualifyReferralOnDelivery).execute(system, input(facts, d));
    const applyAs = async (who: Id<'Account'>) => {
      p3.orderHistory.lastOrder.set(who, null);
      const result = await make(ApplyReferralCode).execute(customerOf(who), { code: referrerCode });
      expect(result.ok).toBe(true);
    };
    const real = () => (confirmed ? { testMode: false } : {});

    beforeEach(async () => {
      await adminCreate(referral(real()));
      const mine = await make(ViewMyReferral).execute(customerOf(REFERRER), {});
      if (!mine.ok) throw new Error('view failed');
      referrerCode = mine.value.code;
    });

    it('credits the referrer and the new customer once the first order is delivered', async () => {
      await applyAs(NEWBIE);
      const facts = deliverOrder(1, NEWBIE, 5000n);
      const result = await qualify(facts);
      expect(result).toEqual({ ok: true, value: { outcome: confirmed ? 'issued' : 'recorded' } });
      expect(
        credits()
          .map((c) => [c.kind, c.recipientAccountId, c.amountMinor])
          .sort(),
      ).toEqual(
        [
          ['REFEREE_REWARD', NEWBIE, 800n],
          ['REFERRER_REWARD', REFERRER, 1000n],
        ].sort(),
      );
      expect(p3.walletCredit.grants).toHaveLength(confirmed ? 2 : 0);
      expect(credits().every((c) => c.status === (confirmed ? 'GRANTED' : 'RECORDED'))).toBe(true);
      expect([...p3.referrals.rows.values()][0]).toMatchObject({
        status: 'QUALIFIED',
        qualifyingOrderId: facts.orderId,
      });
    });

    it('the same event twice, and a later order, credit each person once', async () => {
      await applyAs(NEWBIE);
      const facts = deliverOrder(1, NEWBIE, 5000n);
      const d = delivery();
      await qualify(facts, d);
      expect(await qualify(facts, d)).toEqual({ ok: true, value: { outcome: 'already-handled' } });
      await qualify(facts);
      await qualify(deliverOrder(2, NEWBIE, 7000n));
      expect(credits()).toHaveLength(2);
      expect(p3.walletCredit.grants).toHaveLength(confirmed ? 2 : 0);
    });

    it('does nothing for a customer who was not referred, and reads no wallet', async () => {
      expect(await qualify(deliverOrder(1, NEWBIE, 5000n))).toEqual({
        ok: true,
        value: { outcome: 'nothing' },
      });
      expect(credits()).toHaveLength(0);
    });

    it('rejects a referral of the same household or the same payment, and never rewards it', async () => {
      for (const [verdict, reason, who, n] of [
        ['same-household', 'SAME_HOUSEHOLD', NEWBIE, 1],
        ['same-payment', 'SAME_PAYMENT', NEWBIE_2, 2],
      ] as const) {
        await applyAs(who);
        p3.referralSignals.verdict = verdict;
        expect(await qualify(deliverOrder(n, who, 5000n))).toEqual({
          ok: true,
          value: { outcome: 'rejected' },
        });
        expect(
          [...p3.referrals.rows.values()].find((r) => r.refereeAccountId === who),
        ).toMatchObject({
          status: 'REJECTED',
          rejectReason: reason,
        });
      }
      expect(credits()).toHaveLength(0);
    });

    it('keeps the referral pending when the abuse check cannot tell (fail closed)', async () => {
      await applyAs(NEWBIE);
      p3.referralSignals.verdict = 'unknown';
      expect(await qualify(deliverOrder(1, NEWBIE, 5000n))).toEqual({
        ok: true,
        value: { outcome: 'pending' },
      });
      expect(credits()).toHaveLength(0);
      expect([...p3.referrals.rows.values()][0]!.status).toBe('PENDING');
      p3.referralSignals.verdict = 'clear';
      expect((await qualify(deliverOrder(2, NEWBIE, 5000n))).ok).toBe(true);
      expect(credits()).toHaveLength(2);
    });

    it('expires a referral whose order is delivered after the window', async () => {
      await applyAs(NEWBIE);
      clock.advance(
        Temporal.Duration.from({ hours: 24 * (rules.referral!.qualifyWithinDays + 1) }),
      );
      expect(await qualify(deliverOrder(1, NEWBIE, 5000n))).toEqual({
        ok: true,
        value: { outcome: 'expired' },
      });
      expect(credits()).toHaveLength(0);
      expect([...p3.referrals.rows.values()][0]!.status).toBe('EXPIRED');
    });

    it('ignores an order placed before the code was applied', async () => {
      await applyAs(NEWBIE);
      const early = deliverOrder(1, NEWBIE, 5000n, { placedAt: T0.subtract({ hours: 5 }) });
      expect(await qualify(early)).toEqual({ ok: true, value: { outcome: 'nothing' } });
      expect(credits()).toHaveLength(0);
    });

    it('caps the rewarded referrals of one referrer, and the platform budget', async () => {
      // maxUsesPerCustomer is 2: the third referral is rejected as over the cap.
      const people = [id<'Account'>(0xd1), id<'Account'>(0xd2), id<'Account'>(0xd3)];
      for (const [index, who] of people.entries()) {
        await applyAs(who);
        const result = await qualify(deliverOrder(index + 1, who, 5000n));
        expect(result.ok).toBe(true);
      }
      const states = [...p3.referrals.rows.values()].map((r) => [r.status, r.rejectReason]);
      expect(states).toEqual([
        ['QUALIFIED', null],
        ['QUALIFIED', null],
        ['REJECTED', 'CAP_REACHED'],
      ]);
      expect(credits()).toHaveLength(4);
    });

    it('rejects a referral the budget cannot cover whole', async () => {
      const [made] = [...promotions.records.values()];
      promotions.records.set(made!.id, { ...made!, budgetMinor: 1500n });
      await applyAs(NEWBIE);
      expect(await qualify(deliverOrder(1, NEWBIE, 5000n))).toEqual({
        ok: true,
        value: { outcome: 'rejected' },
      });
      expect([...p3.referrals.rows.values()][0]).toMatchObject({
        status: 'REJECTED',
        rejectReason: 'BUDGET_EXHAUSTED',
      });
      expect(credits()).toHaveLength(0);
    });

    it('retries when the order facts are unknown', async () => {
      await applyAs(NEWBIE);
      const unknown = { orderId: id<'Order'>(0x0d98), sellerOrderId: id<'SellerOrder'>(0x5098) };
      expect(await qualify(unknown)).toEqual({
        ok: false,
        error: { code: 'promotions.try-again' },
      });
    });

    if (confirmed) {
      it('finishes both credits on the retry after a wallet fault, with the same keys', async () => {
        await applyAs(NEWBIE);
        const facts = deliverOrder(1, NEWBIE, 5000n);
        p3.walletCredit.failure = { retry: true, code: 'wallet.unavailable' };
        expect(await qualify(facts)).toEqual({
          ok: false,
          error: { code: 'promotions.try-again' },
        });
        expect(credits().every((c) => c.status === 'PENDING')).toBe(true);
        expect(await qualify(facts)).toEqual({ ok: true, value: { outcome: 'issued' } });
        expect(credits().every((c) => c.status === 'GRANTED')).toBe(true);
        expect(p3.walletCredit.grants).toHaveLength(2);
        expect(new Set(p3.walletCredit.grants.map((g) => g.idempotencyKey)).size).toBe(2);
      });
    } else {
      it('records the intended credits only while the tax ruling is open', async () => {
        const [made] = [...promotions.records.values()];
        expect(made!.testMode).toBe(true);
        await applyAs(NEWBIE);
        await qualify(deliverOrder(1, NEWBIE, 5000n));
        expect(credits().every((c) => c.status === 'RECORDED')).toBe(true);
        expect(p3.walletCredit.grants).toHaveLength(0);
      });
    }
  });

  describe('reading the credits of a promotion', () => {
    it('lists them for an admin manager, newest first, and refuses a seller', async () => {
      const made = await adminCreate(cashback());
      await p3.credits.insert(market, {
        id: id<'PromotionCredit'>(0xc10),
        promotionId: made.id,
        kind: 'CASHBACK',
        recipientAccountId: REFERRER,
        orderId: null,
        sourceKind: 'SELLER_ORDER',
        sourceId: 'a',
        amountMinor: 10n,
        currency,
        status: 'RECORDED',
        failureCode: null,
        walletJournalId: null,
        idempotencyKey: 'promotions:cashback:a1234567',
        createdAt: T0,
        settledAt: T0,
      });
      const listed = await make(ListPromotionCredits).execute(admin(), { promotionId: made.id });
      expect(listed.ok && listed.value).toHaveLength(1);
      expect(
        await make(ListPromotionCredits).execute(admin(), { promotionId: 'nope' }),
      ).toMatchObject({
        ok: false,
      });
      expect(
        await make(ListPromotionCredits).execute(actingAs(admin()), { promotionId: made.id }),
      ).toMatchObject({
        ok: false,
      });
    });
  });
});
