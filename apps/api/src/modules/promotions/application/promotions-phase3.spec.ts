import { QuoteOwnDiscounts } from './use-cases/quote-own-discounts.use-case';
import { RedeemOwnDiscounts } from './use-cases/redeem-own-discounts.use-case';
import { ListStaleRedemptions } from './use-cases/list-stale-redemptions.use-case';
import { SettleRedemptions } from './use-cases/settle-redemptions.use-case';
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
  FakeSellerCatalogue,
  FakeSellerCommission,
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
import type { PromotionsPolicy } from './ports/promotions-policy';
import { ConfigPromotionsPolicy } from '../infrastructure/config-promotions-policy';
import { PromotionsFacadeImplementation } from '../presentation/promotions.facade';
import type { PromotionsDependencies } from './promotions-dependencies';
import { ApplyReferralCode } from './use-cases/apply-referral-code.use-case';
import { ClawBackOnRefund } from './use-cases/claw-back-on-refund.use-case';
import { GrantDueCredits } from './use-cases/grant-due-credits.use-case';
import { CashbackOnDelivery } from './use-cases/cashback-on-delivery.use-case';
import { CheckWasPrice } from './use-cases/check-was-price.use-case';
import { CreateOwnPromotion } from './use-cases/create-own-promotion.use-case';
import { CreatePromotion } from './use-cases/create-promotion.use-case';
import { EditPromotion } from './use-cases/edit-promotion.use-case';
import { ListCustomerPromotionCredits } from './use-cases/list-customer-promotion-credits.use-case';
import { ListCustomerPromotionUsages } from './use-cases/list-customer-promotion-usages.use-case';
import type { RedemptionRecord } from '../domain/redemption';
import { ListPromotionCredits } from './use-cases/list-promotion-credits.use-case';
import { PreviewQuote } from './use-cases/preview-quote.use-case';
import { QualifyReferralOnDelivery } from './use-cases/qualify-referral-on-delivery.use-case';
import { QuoteDiscounts } from './use-cases/quote-discounts.use-case';
import { RedeemDiscounts } from './use-cases/redeem-discounts.use-case';
import { SetPromotionBudget } from './use-cases/set-promotion-budget.use-case';
import { SetPromotionsStatus } from './use-cases/set-promotions-status.use-case';
import { ViewMyReferral } from './use-cases/view-my-referral.use-case';
import { ViewStoreFollowGift } from './use-cases/view-store-follow-gift.use-case';
import type { PromotionRecord } from '../domain/promotion';

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
  const rulingConfirmed = rules.gstRulingConfirmed;
  /** The ruling the current test runs with: the Market's own, or the override of a money path. */
  let rulingInForce = rulingConfirmed;
  /** The Market's own policy with the tax ruling taken as confirmed. */
  const confirmedPolicy: PromotionsPolicy = {
    settings: (m) => {
      const own = policy.settings(m);
      return own === null ? null : { ...own, rules: { ...own.rules, gstRulingConfirmed: true } };
    },
  };

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
    new PromotionsFacadeImplementation(
      make(QuoteDiscounts),
      make(RedeemDiscounts),
      make(CheckWasPrice),
      make(QuoteOwnDiscounts),
      make(RedeemOwnDiscounts),
      make(ListStaleRedemptions),
      make(SettleRedemptions),
    );

  beforeEach(async () => {
    rulingInForce = rulingConfirmed;
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
      sellerCommission: new FakeSellerCommission(),
      sellerCatalogue: new FakeSellerCatalogue(),
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
    testMode: !rulingInForce,
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

      const sellerReferral = await make(CreateOwnPromotion).execute(
        seller(),
        referral({ funding: 'SELLER', budgetMinor: undefined, testMode: false }),
      );
      expect(fields(sellerReferral)).toContain('type:not-allowed');
      // A seller's cashback is for its exclusive customers only (customers phase 4c).
      const sellerCashback = await make(CreateOwnPromotion).execute(
        seller(),
        cashback({ funding: 'SELLER', budgetMinor: undefined, testMode: false }),
      );
      expect(fields(sellerCashback)).toContain('segment.kind:required');
      // A seller's customer-group discount is for its exclusive customers only.
      const otherSegment = await make(CreateOwnPromotion).execute(
        seller(),
        group({ funding: 'SELLER', budgetMinor: undefined, testMode: false }),
      );
      expect(fields(otherSegment)).toContain('segment.kind:not-allowed');
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
      if (rulingConfirmed) expect(result.ok).toBe(true);
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
        grantAfter: null,
        earnedOn: null,
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
      expect(real.totals.goodsDiscount).toBe(rulingConfirmed ? 1000n : 0n);
    });

    describe('manual group segment (customers phase 2)', () => {
      const GROUP = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
      const manual = () =>
        group({
          segment: { kind: 'MANUAL_GROUP', groupId: GROUP },
          reward: { kind: 'PERCENT', bps: 500 },
        });

      it('applies to a customer in the group, and asks once per group', async () => {
        await adminCreate(manual());
        p3.groupMembership.members.set(GROUP, new Set([REFERRER]));
        expect((await quote(cart())).totals.goodsDiscount).toBe(500n);
        expect(p3.groupMembership.reads).toBe(1);
        expect(p3.orderHistory.reads).toBe(0);
      });

      it('is not offered to a non-member, when the read fails or throws, or with no customer', async () => {
        await adminCreate(manual());
        expect((await quote(cart())).totals.goodsDiscount).toBe(0n);
        p3.groupMembership.members.set(GROUP, new Set([REFERRER]));
        p3.groupMembership.broken = true;
        expect((await quote(cart())).totals.goodsDiscount).toBe(0n);
        p3.groupMembership.broken = false;
        p3.groupMembership.throws = true;
        expect((await quote(cart())).totals.goodsDiscount).toBe(0n);
        p3.groupMembership.throws = false;
        expect(
          (await quote(request([line(1, 10000n, 1)], { customerAccountId: null }))).totals
            .goodsDiscount,
        ).toBe(0n);
      });

      it('needs a well-formed group id, and takes no days or zones', async () => {
        expect(
          fields(
            await make(CreatePromotion).execute(
              admin(),
              group({ segment: { kind: 'MANUAL_GROUP' } }),
            ),
          ),
        ).toContain('segment.groupId:required');
        expect(
          fields(
            await make(CreatePromotion).execute(
              admin(),
              group({ segment: { kind: 'MANUAL_GROUP', groupId: 'nope' } }),
            ),
          ),
        ).toContain('segment.groupId:format');
        expect(
          fields(
            await make(CreatePromotion).execute(
              admin(),
              group({
                segment: { kind: 'MANUAL_GROUP', groupId: GROUP, minDaysSinceLastOrder: 30 },
              }),
            ),
          ),
        ).toContain('segment.minDaysSinceLastOrder:not-allowed');
        expect(
          fields(
            await make(CreatePromotion).execute(
              admin(),
              group({ segment: { kind: 'RETURNING_CUSTOMER', groupId: GROUP } }),
            ),
          ),
        ).toContain('segment.groupId:not-allowed');
      });

      it('shows the group id on the promotion', async () => {
        const made = await adminCreate(manual());
        expect(made.segment).toEqual({
          kind: 'MANUAL_GROUP',
          minDaysSinceLastOrder: null,
          groupId: GROUP,
        });
      });
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

  describe('exclusive-customer discount (customers phase 4a)', () => {
    const exclusive = (extra: Record<string, unknown> = {}) => ({
      type: 'CUSTOMER_GROUP',
      name: 'For our customers',
      funding: 'SELLER',
      startsAt: startsAt(),
      reward: { kind: 'PERCENT', bps: 1000 },
      segment: { kind: 'SELLER_EXCLUSIVE' },
      ...extra,
    });
    const cart = () => request([line(1, 10000n, 1), line(2, 10000n, 1, SELLER_2)]);

    it('lets a seller make it with its own money, on its own lines, for its exclusive customers', async () => {
      const made = await sellerCreate(exclusive());
      expect(made.segment).toMatchObject({ kind: 'SELLER_EXCLUSIVE' });
      p3.exclusiveCustomers.sellers.set(REFERRER, SELLER);
      const out = await quote(cart());
      expect(out.totals.goodsDiscount).toBe(1000n);
      expect(out.totals.sellerShare).toBe(1000n);
      expect(out.totals.platformShare).toBe(0n);
      expect(p3.exclusiveCustomers.reads).toBe(1);
    });

    it('is not offered to another seller’s customer, an unattributed one, or with no customer', async () => {
      await sellerCreate(exclusive());
      expect((await quote(cart())).totals.goodsDiscount).toBe(0n);
      p3.exclusiveCustomers.sellers.set(REFERRER, SELLER_2);
      expect((await quote(cart())).totals.goodsDiscount).toBe(0n);
      p3.exclusiveCustomers.sellers.set(REFERRER, SELLER);
      expect(
        (await quote(request([line(1, 10000n, 1)], { customerAccountId: null }))).totals
          .goodsDiscount,
      ).toBe(0n);
    });

    it('fails closed when the attribution is unknown or the read throws', async () => {
      await sellerCreate(exclusive());
      p3.exclusiveCustomers.sellers.set(REFERRER, SELLER);
      p3.exclusiveCustomers.broken = true;
      expect((await quote(cart())).totals.goodsDiscount).toBe(0n);
      p3.exclusiveCustomers.broken = false;
      p3.exclusiveCustomers.throws = true;
      expect((await quote(cart())).totals.goodsDiscount).toBe(0n);
    });

    it('reads no attribution when no such discount is live', async () => {
      p3.exclusiveCustomers.sellers.set(REFERRER, SELLER);
      await quote(cart());
      expect(p3.exclusiveCustomers.reads).toBe(0);
    });

    it('is held to the seller maximum and takes no days, zones, platform money or test mode', async () => {
      const own = (body: Record<string, unknown>) =>
        make(CreateOwnPromotion).execute(seller(), body);
      expect(
        fields(
          await own(
            exclusive({ reward: { kind: 'PERCENT', bps: rules.sellerMaxDiscountBps + 1 } }),
          ),
        ),
      ).toContain('reward.bps:exceeds-seller-maximum');
      expect(
        fields(
          await own(
            exclusive({ segment: { kind: 'SELLER_EXCLUSIVE', minDaysSinceLastOrder: 30 } }),
          ),
        ),
      ).toContain('segment.minDaysSinceLastOrder:not-allowed');
      expect(fields(await own(exclusive({ zones: ['BRIS-1'] })))).toContain('zones:not-allowed');
      expect(fields(await own(exclusive({ funding: 'PLATFORM' })))).toContain(
        'funding:seller-money-only',
      );
      expect(fields(await own(exclusive({ testMode: true })))).toContain('testMode:not-allowed');
      expect(promotions.records.size).toBe(0);
    });

    it('is not an admin’s to make', async () => {
      const result = await make(CreatePromotion).execute(
        admin(),
        group({ segment: { kind: 'SELLER_EXCLUSIVE' } }),
      );
      expect(fields(result)).toContain('segment.kind:not-allowed');
    });

    it('is not listed as a Follow gift', async () => {
      await sellerCreate(exclusive());
      expect(
        await make(ViewStoreFollowGift).execute(
          testCallContext(market, 'anonymous', 'promo3-anon-abcdef'),
          { sellerId: SELLER },
        ),
      ).toEqual({ ok: true, value: { gifts: [] } });
    });
  });

  describe('the Follow gift (store page)', () => {
    const anonymous = () => testCallContext(market, 'anonymous', 'promo3-anon-abcdef');
    const gifts = (sellerId: string, context: CallContext = anonymous()) =>
      make(ViewStoreFollowGift).execute(context, { sellerId });
    const edit = (promotionId: string, over: Partial<PromotionRecord>) => {
      const record = promotions.records.get(promotionId as Id<'Promotion'>)!;
      promotions.records.set(record.id, { ...record, ...over });
    };

    it("lists the store's live follower offers, anonymously, and no other store's", async () => {
      const made = await sellerCreate(follower());
      const answer = await gifts(SELLER);
      expect(answer).toEqual({
        ok: true,
        value: {
          gifts: [
            {
              promotionId: made.id,
              name: 'For followers',
              reward: { kind: 'PERCENT', bps: 1000 },
              currency,
              minSpendMinor: null,
              endsAt: null,
            },
          ],
        },
      });
      expect(await gifts(SELLER_2)).toEqual({ ok: true, value: { gifts: [] } });
    });

    it('leaves out test-mode, coded, paused and ended offers', async () => {
      for (const over of [
        { testMode: true },
        { code: 'FOLLOW10' },
        { status: 'PAUSED' as const },
        { endsAt: T0.subtract({ hours: 1 }) },
      ]) {
        const made = await sellerCreate(follower());
        edit(made.id, over);
      }
      expect(await gifts(SELLER)).toEqual({ ok: true, value: { gifts: [] } });
    });

    it('answers no gift with promotions off, and refuses a bad store id', async () => {
      await sellerCreate(follower());
      await make(SetPromotionsStatus).execute(admin(), { status: 'off' });
      expect(await gifts(SELLER)).toEqual({ ok: true, value: { gifts: [] } });
      expect(await gifts('not-a-store')).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
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
      sellerId?: Id<'Seller'>;
      exclusiveSeller?: boolean;
    } = {},
  ) => {
    const facts = {
      orderId: over.orderId ?? id<'Order'>(0x0d00 + n),
      sellerOrderId: id<'SellerOrder'>(0x5000 + n),
      sellerId: over.sellerId ?? SELLER,
      customerAccountId: who,
      goodsPaid: money(goodsMinor, over.goodsCurrency ?? currency),
      exclusiveSeller: over.exclusiveSeller ?? true,
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

  // The money paths run twice: with the Market's own ruling, and with the ruling overridden as
  // confirmed (the config file stays as it is), so a Market whose ruling is open is tested on real
  // money too.
  describe.each([[false], [true]] as const)('money paths, ruling override %s', (override) => {
    const confirmed = override || rulingConfirmed;
    beforeEach(() => {
      rulingInForce = confirmed;
      if (override) deps = { ...deps, policy: confirmedPolicy };
    });
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
        const amounts = credits()
          .map((c) => c.amountMinor)
          .sort();
        // A test-mode note is not money: it counts toward no cap.
        expect(amounts).toEqual(confirmed ? [200n, 500n] : [500n, 500n]);
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

      describe('a seller’s own cashback for its exclusive customers (customers phase 4c)', () => {
        const sellerCashback = (extra: Record<string, unknown> = {}) =>
          sellerCreate({
            type: 'CASHBACK',
            name: 'Our cashback',
            funding: 'SELLER',
            startsAt: startsAt(),
            reward: { kind: 'PERCENT', bps: 500 },
            capMinor: '400',
            segment: { kind: 'SELLER_EXCLUSIVE' },
            ...extra,
          });
        const ledger = () => p3.sellerCashbackLedger;

        it('credits the exclusive customer on the seller’s own order and debits the seller, whatever the tax ruling', async () => {
          await sellerCashback();
          p3.exclusiveCustomers.sellers.set(REFERRER, SELLER);
          const facts = deliverOrder(1, REFERRER, 10000n);
          const d = delivery();
          expect(await run(facts, d)).toEqual({ ok: true, value: { outcome: 'issued' } });
          // 5% of 100.00 is 5.00, held to the seller's per-order cap of 4.00.
          expect(p3.walletCredit.grants).toHaveLength(1);
          expect(p3.walletCredit.grants[0]).toMatchObject({
            accountId: REFERRER,
            amount: money(400n, currency),
          });
          expect(credits()[0]).toMatchObject({ status: 'GRANTED', amountMinor: 400n });
          expect(ledger().entries).toEqual([
            expect.objectContaining({
              creditId: credits()[0]!.id,
              orderId: facts.orderId,
              sellerOrderId: facts.sellerOrderId,
              sellerId: SELLER,
              amount: 400n,
              currency,
            }),
          ]);
          // A redelivery, and a new event for the same order, neither credit nor debit again.
          expect(await run(facts, d)).toEqual({ ok: true, value: { outcome: 'already-handled' } });
          await run(facts);
          expect(credits()).toHaveLength(1);
          expect(p3.walletCredit.grants).toHaveLength(1);
          expect(ledger().entries).toHaveLength(1);
        });

        it('gives nothing to another seller’s customer, an unattributed one, or on another seller’s order', async () => {
          await sellerCashback();
          await run(deliverOrder(1, REFERRER, 10000n));
          p3.exclusiveCustomers.sellers.set(REFERRER, SELLER_2);
          await run(deliverOrder(2, REFERRER, 10000n));
          p3.exclusiveCustomers.sellers.set(REFERRER, SELLER);
          await run(deliverOrder(3, REFERRER, 10000n, { sellerId: SELLER_2 }));
          expect(credits()).toHaveLength(0);
          expect(ledger().calls).toBe(0);
        });

        it('retries when the customer’s seller cannot be read, and asks only when a seller cashback is live', async () => {
          await adminCreate(cashback({ testMode: !confirmed }));
          await run(deliverOrder(1, REFERRER, 10000n));
          expect(p3.exclusiveCustomers.reads).toBe(0);
          await sellerCashback();
          p3.exclusiveCustomers.broken = true;
          const facts = deliverOrder(2, REFERRER, 10000n);
          expect(await run(facts)).toEqual({ ok: false, error: { code: 'promotions.try-again' } });
          p3.exclusiveCustomers.broken = false;
          p3.exclusiveCustomers.throws = true;
          expect(await run(facts)).toEqual({ ok: false, error: { code: 'promotions.try-again' } });
        });

        it('keeps the credit pending while the seller ledger refuses, then debits once on the retry', async () => {
          await sellerCashback();
          p3.exclusiveCustomers.sellers.set(REFERRER, SELLER);
          const facts = deliverOrder(1, REFERRER, 10000n);
          ledger().fails = true;
          expect(await run(facts)).toEqual({ ok: false, error: { code: 'promotions.try-again' } });
          expect(credits()[0]!.status).toBe('PENDING');
          ledger().fails = false;
          expect(await run(facts)).toEqual({ ok: true, value: { outcome: 'issued' } });
          // The wallet answers the repeat with the same journal: the customer is credited once.
          expect(p3.walletCredit.grants).toHaveLength(1);
          expect(ledger().entries).toHaveLength(1);
          expect(credits()[0]!.status).toBe('GRANTED');
        });

        it('fails for good, debiting nothing, when the wallet is off', async () => {
          await sellerCashback();
          p3.exclusiveCustomers.sellers.set(REFERRER, SELLER);
          p3.walletCredit.failure = { retry: true, code: 'wallet.disabled' };
          expect(await run(deliverOrder(1, REFERRER, 10000n))).toEqual({
            ok: true,
            value: { outcome: 'failed' },
          });
          expect(credits()[0]).toMatchObject({ status: 'FAILED', failureCode: 'wallet.disabled' });
          expect(ledger().calls).toBe(0);
        });

        it('pays the larger of the platform’s and the seller’s cashback, not both', async () => {
          // The platform's real money is in play only with the ruling confirmed; otherwise its
          // promotion is test mode and only notes.
          await adminCreate(
            cashback({ testMode: !confirmed, reward: { kind: 'PERCENT', bps: 200 } }),
          );
          await sellerCashback({ capMinor: '1000' });
          p3.exclusiveCustomers.sellers.set(REFERRER, SELLER);
          await run(deliverOrder(1, REFERRER, 10000n));
          expect(credits().map((c) => c.amountMinor)).toEqual([500n]);
          expect(ledger().entries.map((e) => e.amount)).toEqual([500n]);
        });
      });

      describe('waiting for the seller order’s payout release (customers phase 4c, Hassan H-1)', () => {
        const HOLD = { hours: 24 * 14 };
        const grantDue = () => make(GrantDueCredits).execute(system, undefined);
        const sellerCashback = () =>
          sellerCreate({
            type: 'CASHBACK',
            name: 'Our cashback',
            funding: 'SELLER',
            startsAt: startsAt(),
            reward: { kind: 'PERCENT', bps: 500 },
            capMinor: '400',
            segment: { kind: 'SELLER_EXCLUSIVE' },
          });
        /** Delivered now, released after the hold. */
        const deliverHeld = (n: number, goods = 10000n) => {
          const facts = deliverOrder(n, REFERRER, goods);
          p3.payoutAnchors.anchors.set(facts.sellerOrderId, {
            sellerId: facts.sellerId,
            eligibleAt: clock.now().add(HOLD),
          });
          return facts;
        };

        it('reserves the credit at delivery and credits it, with the seller debit, only once the payout is released', async () => {
          await sellerCashback();
          p3.exclusiveCustomers.sellers.set(REFERRER, SELLER);
          const facts = deliverHeld(1);
          expect(await run(facts)).toEqual({ ok: true, value: { outcome: 'pending' } });
          expect(credits()[0]).toMatchObject({ status: 'PENDING', amountMinor: 400n });
          expect(credits()[0]!.grantAfter).not.toBeNull();
          expect(p3.walletCredit.calls).toBe(0);
          // A redelivery waits too.
          expect(await run(facts)).toEqual({ ok: true, value: { outcome: 'pending' } });
          expect(await grantDue()).toEqual({
            ok: true,
            value: { issued: 0, failed: 0, retried: 0, held: 0 },
          });
          clock.advance(Temporal.Duration.from(HOLD));
          expect(await grantDue()).toEqual({
            ok: true,
            value: { issued: 1, failed: 0, retried: 0, held: 0 },
          });
          expect(credits()[0]).toMatchObject({
            status: 'GRANTED',
            amountMinor: 400n,
            grantAfter: null,
          });
          expect(p3.walletCredit.grants.map((g) => g.amount)).toEqual([money(400n, currency)]);
          expect(p3.sellerCashbackLedger.entries.map((e) => e.amount)).toEqual([400n]);
          // Done: the next run finds nothing.
          expect(await grantDue()).toEqual({
            ok: true,
            value: { issued: 0, failed: 0, retried: 0, held: 0 },
          });
        });

        it('lowers the credit for what refunds gave back inside the hold, and cancels it when nothing is left', async () => {
          await sellerCashback();
          p3.exclusiveCustomers.sellers.set(REFERRER, SELLER);
          const kept = deliverHeld(1);
          const gone = deliverHeld(2);
          await run(kept);
          await run(gone);
          // 6000 of 10000 refunded: 4000 of the 10000 it was earned on keep 400 × 0.4 = 160.
          p3.orderFacts.add({ ...kept, goodsPaid: money(4000n, currency) });
          p3.orderFacts.add({ ...gone, goodsPaid: money(0n, currency) });
          clock.advance(Temporal.Duration.from(HOLD));
          expect(await grantDue()).toEqual({
            ok: true,
            value: { issued: 1, failed: 1, retried: 0, held: 0 },
          });
          const bySource = new Map(credits().map((c) => [c.sourceId, c]));
          expect(bySource.get(kept.sellerOrderId)).toMatchObject({
            status: 'GRANTED',
            amountMinor: 160n,
          });
          expect(bySource.get(gone.sellerOrderId)).toMatchObject({
            status: 'FAILED',
            failureCode: 'order-refunded',
          });
          expect(p3.walletCredit.grants.map((g) => g.amount)).toEqual([money(160n, currency)]);
          expect(p3.sellerCashbackLedger.entries.map((e) => e.amount)).toEqual([160n]);
        });

        it('pays what was earned at delivery when the seller lowers its rate during the hold (Hassan H-2)', async () => {
          await sellerCashback();
          p3.exclusiveCustomers.sellers.set(REFERRER, SELLER);
          await run(deliverHeld(1));
          const credit = credits()[0]!;
          expect(credit.earnedOn).toEqual({ reservedMinor: 400n, goodsMinor: 10000n });
          const promotion = promotions.records.get(credit.promotionId)!;
          promotions.records.set(promotion.id, {
            ...promotion,
            reward: { kind: 'PERCENT', bps: 100 },
          });
          clock.advance(Temporal.Duration.from(HOLD));
          await grantDue();
          expect(credits()[0]).toMatchObject({ status: 'GRANTED', amountMinor: 400n });
        });

        it('cancels a seller’s cashback whose customer stopped being its exclusive customer during the hold', async () => {
          await sellerCashback();
          p3.exclusiveCustomers.sellers.set(REFERRER, SELLER);
          await run(deliverHeld(1));
          p3.exclusiveCustomers.sellers.delete(REFERRER);
          clock.advance(Temporal.Duration.from(HOLD));
          expect(await grantDue()).toEqual({
            ok: true,
            value: { issued: 0, failed: 1, retried: 0, held: 0 },
          });
          expect(credits()[0]).toMatchObject({ status: 'FAILED', failureCode: 'not-exclusive' });
          expect(p3.walletCredit.calls).toBe(0);
          expect(p3.sellerCashbackLedger.calls).toBe(0);
        });

        it('tries again next run when the facts, the attribution or the ledger cannot be reached', async () => {
          await sellerCashback();
          p3.exclusiveCustomers.sellers.set(REFERRER, SELLER);
          const facts = deliverHeld(1);
          await run(facts);
          clock.advance(Temporal.Duration.from(HOLD));
          p3.orderFacts.orders.delete(facts.sellerOrderId);
          expect(await grantDue()).toEqual({
            ok: true,
            value: { issued: 0, failed: 0, retried: 1, held: 0 },
          });
          p3.orderFacts.add(facts);
          // Put back for an hour (Hassan L-4): not due again before then.
          expect(await grantDue()).toEqual({
            ok: true,
            value: { issued: 0, failed: 0, retried: 0, held: 0 },
          });
          clock.advance(Temporal.Duration.from({ minutes: 61 }));
          p3.exclusiveCustomers.broken = true;
          expect((await grantDue()).ok && credits()[0]!.status).toBe('PENDING');
          p3.exclusiveCustomers.broken = false;
          clock.advance(Temporal.Duration.from({ minutes: 61 }));
          p3.sellerCashbackLedger.fails = true;
          expect(await grantDue()).toEqual({
            ok: true,
            value: { issued: 0, failed: 0, retried: 1, held: 0 },
          });
          // The amount is final now; the wallet holds it under its key, the seller is not debited.
          expect(credits()[0]).toMatchObject({ status: 'PENDING', grantAfter: null });
          p3.sellerCashbackLedger.fails = false;
          // A fixed credit is finished as it is, after a while, with no new check.
          p3.exclusiveCustomers.sellers.delete(REFERRER);
          clock.advance(Temporal.Duration.from({ minutes: 61 }));
          expect(await grantDue()).toEqual({
            ok: true,
            value: { issued: 1, failed: 0, retried: 0, held: 0 },
          });
          expect(p3.walletCredit.grants).toHaveLength(1);
          expect(p3.sellerCashbackLedger.entries).toHaveLength(1);
        });

        it('makes the platform’s real cashback wait too', async () => {
          await adminCreate(cashback({ testMode: !confirmed }));
          const facts = deliverHeld(1);
          const result = await run(facts);
          if (confirmed) {
            expect(result).toEqual({ ok: true, value: { outcome: 'pending' } });
            clock.advance(Temporal.Duration.from(HOLD));
            expect((await grantDue()).ok && credits()[0]!.status).toBe('GRANTED');
          } else {
            // A test-mode note never waits: it moves no money.
            expect(result).toEqual({ ok: true, value: { outcome: 'recorded' } });
          }
        });

        it('retries while the payout anchor is unknown, and credits nothing on an anchor of another seller', async () => {
          await sellerCashback();
          p3.exclusiveCustomers.sellers.set(REFERRER, SELLER);
          p3.payoutAnchors.broken = true;
          const facts = deliverOrder(1, REFERRER, 10000n);
          expect(await run(facts)).toEqual({ ok: false, error: { code: 'promotions.try-again' } });
          p3.payoutAnchors.broken = false;
          p3.payoutAnchors.anchors.set(facts.sellerOrderId, {
            sellerId: SELLER_2,
            eligibleAt: clock.now(),
          });
          expect((await run(facts)).ok).toBe(true);
          expect(credits()).toHaveLength(0);
        });

        it('keeps the credit waiting while a payout hold covers the seller order, and credits it once the hold goes (Hassan M-2)', async () => {
          await sellerCashback();
          p3.exclusiveCustomers.sellers.set(REFERRER, SELLER);
          const facts = deliverHeld(1);
          await run(facts);
          // A chargeback is opened during the hold.
          p3.payoutAnchors.held.add(facts.sellerOrderId);
          clock.advance(Temporal.Duration.from(HOLD));
          expect(await grantDue()).toEqual({
            ok: true,
            value: { issued: 0, failed: 0, retried: 0, held: 1 },
          });
          expect(credits()[0]).toMatchObject({ status: 'PENDING', amountMinor: 400n });
          expect(credits()[0]!.grantAfter!.epochMilliseconds).toBe(
            clock.now().add({ hours: 6 }).epochMilliseconds,
          );
          expect(p3.walletCredit.calls).toBe(0);
          expect(p3.sellerCashbackLedger.calls).toBe(0);
          // Not due again before the re-check, even with the hold gone.
          p3.payoutAnchors.held.delete(facts.sellerOrderId);
          expect(await grantDue()).toEqual({
            ok: true,
            value: { issued: 0, failed: 0, retried: 0, held: 0 },
          });
          clock.advance(Temporal.Duration.from({ hours: 6 }));
          expect(await grantDue()).toEqual({
            ok: true,
            value: { issued: 1, failed: 0, retried: 0, held: 0 },
          });
          expect(p3.walletCredit.grants.map((g) => g.amount)).toEqual([money(400n, currency)]);
        });

        it('cancels the credit when a chargeback took the seller order’s money (Hassan M-2)', async () => {
          await sellerCashback();
          p3.exclusiveCustomers.sellers.set(REFERRER, SELLER);
          const facts = deliverHeld(1);
          await run(facts);
          p3.payoutAnchors.held.add(facts.sellerOrderId);
          p3.payoutAnchors.disputesLost.add(facts.sellerOrderId);
          clock.advance(Temporal.Duration.from(HOLD));
          expect(await grantDue()).toEqual({
            ok: true,
            value: { issued: 0, failed: 1, retried: 0, held: 0 },
          });
          expect(credits()[0]).toMatchObject({ status: 'FAILED', failureCode: 'order-disputed' });
          expect(p3.walletCredit.calls).toBe(0);
          expect(p3.sellerCashbackLedger.calls).toBe(0);
        });

        it('reserves nothing for a seller order a chargeback already took, and makes a held one wait even after its release date', async () => {
          await sellerCashback();
          p3.exclusiveCustomers.sellers.set(REFERRER, SELLER);
          const lost = deliverOrder(1, REFERRER, 10000n);
          p3.payoutAnchors.disputesLost.add(lost.sellerOrderId);
          expect((await run(lost)).ok).toBe(true);
          expect(credits()).toHaveLength(0);
          // Released already (the default anchor is in the past), but held now.
          const held = deliverOrder(2, REFERRER, 10000n);
          p3.payoutAnchors.held.add(held.sellerOrderId);
          expect(await run(held)).toEqual({ ok: true, value: { outcome: 'pending' } });
          expect(credits()[0]).toMatchObject({ status: 'PENDING' });
          expect(credits()[0]!.grantAfter).not.toBeNull();
          expect(p3.walletCredit.calls).toBe(0);
          expect(await grantDue()).toEqual({
            ok: true,
            value: { issued: 0, failed: 0, retried: 0, held: 1 },
          });
        });

        describe('a refund after the cashback was credited (customers phase 4c-2)', () => {
          const REFUND_1 = id<'Refund'>(0xf001);
          const REFUND_2 = id<'Refund'>(0xf002);
          const refund = (
            facts: { orderId: Id<'Order'>; sellerOrderId: Id<'SellerOrder'> },
            refundId: Id<'Refund'>,
            d = delivery(),
          ) =>
            make(ClawBackOnRefund).execute(system, {
              delivery: d,
              orderId: facts.orderId,
              sellerOrderId: facts.sellerOrderId,
              refundId,
            });
          /**
           * A seller's cashback of 400 (5 % of 10000, capped at 400), credited after the hold: earned
           * on 10000, so what it keeps is pro rata to the goods kept.
           */
          const credited = async () => {
            await sellerCashback();
            p3.exclusiveCustomers.sellers.set(REFERRER, SELLER);
            const facts = deliverHeld(1);
            await run(facts);
            clock.advance(Temporal.Duration.from(HOLD));
            await grantDue();
            expect(credits()[0]).toMatchObject({ status: 'GRANTED', amountMinor: 400n });
            return facts;
          };
          const clawbacks = () => p3.credits.clawbacks;

          it('takes back what the goods given back no longer earn, and returns it to the seller', async () => {
            const facts = await credited();
            // 4000 of 10000 refunded: 6000 kept keep 400 × 0.6 = 240, so 160 comes back.
            p3.orderFacts.add({ ...facts, goodsPaid: money(6000n, currency) });
            const d = delivery();
            expect(await refund(facts, REFUND_1, d)).toEqual({
              ok: true,
              value: { outcome: 'clawed-back' },
            });
            expect(clawbacks()).toMatchObject([
              { refundId: REFUND_1, seq: 1, amountMinor: 160n, status: 'DONE', clawedMinor: 160n },
            ]);
            expect([...p3.walletCredit.clawbacks.values()]).toMatchObject([
              { asked: 160n, taken: 160n },
            ]);
            expect(p3.sellerCashbackLedger.returns).toMatchObject([
              { clawbackId: clawbacks()[0]!.id, amount: 160n, sellerId: SELLER },
            ]);
            // The same delivery again changes nothing.
            expect(await refund(facts, REFUND_1, d)).toEqual({
              ok: true,
              value: { outcome: 'already-handled' },
            });
            // A second refund: 2000 kept keep 80, so 160 more comes back.
            p3.orderFacts.add({ ...facts, goodsPaid: money(2000n, currency) });
            expect((await refund(facts, REFUND_2)).ok).toBe(true);
            expect(clawbacks().map((c) => [c.seq, c.amountMinor, c.clawedMinor])).toEqual([
              [1, 160n, 160n],
              [2, 160n, 160n],
            ]);
            expect(p3.sellerCashbackLedger.returns.map((r) => r.amount)).toEqual([160n, 160n]);
          });

          it('leaves what the customer spent, and returns to the seller only what was taken', async () => {
            const facts = await credited();
            const journal = credits()[0]!.walletJournalId!;
            p3.walletCredit.spent.set(journal, 350n);
            p3.orderFacts.add({ ...facts, goodsPaid: money(0n, currency) });
            expect((await refund(facts, REFUND_1)).ok).toBe(true);
            expect(clawbacks()).toMatchObject([{ amountMinor: 400n, clawedMinor: 50n }]);
            expect(p3.sellerCashbackLedger.returns.map((r) => r.amount)).toEqual([50n]);
            // Nothing more is asked for later: the credit is accounted for in full.
            expect(await refund(facts, REFUND_2)).toEqual({
              ok: true,
              value: { outcome: 'nothing' },
            });
          });

          it('takes nothing back for a refund that gave no goods back (shipping only)', async () => {
            const facts = await credited();
            p3.orderFacts.add({ ...facts, goodsPaid: money(10000n, currency) });
            expect(await refund(facts, REFUND_1)).toEqual({
              ok: true,
              value: { outcome: 'nothing' },
            });
            expect(clawbacks()).toHaveLength(0);
            expect(p3.walletCredit.clawbacks.size).toBe(0);
          });

          it('does nothing for a credit still waiting for the release (the grant job nets it), and retries one being paid (Hassan L-5)', async () => {
            await sellerCashback();
            p3.exclusiveCustomers.sellers.set(REFERRER, SELLER);
            const facts = deliverHeld(1);
            await run(facts);
            expect(await refund(facts, REFUND_1)).toEqual({
              ok: true,
              value: { outcome: 'nothing' },
            });
            // The wait has ended but the wallet has not answered yet.
            clock.advance(Temporal.Duration.from(HOLD));
            p3.walletCredit.failure = { retry: true, code: 'wallet.unavailable' };
            p3.walletCredit.always = true;
            await grantDue();
            p3.walletCredit.always = false;
            p3.walletCredit.failure = null;
            expect(credits()[0]).toMatchObject({ status: 'PENDING', grantAfter: null });
            expect(await refund(facts, REFUND_2)).toEqual({
              ok: false,
              error: { code: 'promotions.try-again' },
            });
          });

          it('keeps the clawback pending while the wallet or the ledger cannot answer, and finishes it on the retry with the same key', async () => {
            const facts = await credited();
            p3.orderFacts.add({ ...facts, goodsPaid: money(6000n, currency) });
            const d = delivery();
            p3.walletCredit.failure = { retry: true, code: 'wallet.unavailable' };
            expect(await refund(facts, REFUND_1, d)).toEqual({
              ok: false,
              error: { code: 'promotions.try-again' },
            });
            expect(clawbacks()).toMatchObject([{ status: 'PENDING', amountMinor: 160n }]);
            p3.sellerCashbackLedger.fails = true;
            expect((await refund(facts, REFUND_1, d)).ok).toBe(false);
            p3.sellerCashbackLedger.fails = false;
            // A later refund read meanwhile changes nothing for this one: its share is fixed.
            p3.orderFacts.add({ ...facts, goodsPaid: money(2000n, currency) });
            expect(await refund(facts, REFUND_1, d)).toEqual({
              ok: true,
              value: { outcome: 'clawed-back' },
            });
            expect(clawbacks()).toMatchObject([
              { status: 'DONE', amountMinor: 160n, clawedMinor: 160n },
            ]);
            expect(p3.walletCredit.clawbacks.size).toBe(1);
            expect(p3.sellerCashbackLedger.returns).toHaveLength(1);
          });

          it('takes back only the share of the goods given back after the seller lowered its rate (Hassan H-2)', async () => {
            const facts = await credited();
            // The seller cuts its cashback to 1 % after the customer earned 400.
            const credit = credits()[0]!;
            const promotion = promotions.records.get(credit.promotionId)!;
            promotions.records.set(promotion.id, {
              ...promotion,
              reward: { kind: 'PERCENT', bps: 100 },
            });
            // One cheap unit of 100 given back: 9900 kept keep ceil(400 × 0.99) = 396.
            p3.orderFacts.add({ ...facts, goodsPaid: money(9900n, currency) });
            expect((await refund(facts, REFUND_1)).ok).toBe(true);
            expect(clawbacks()).toMatchObject([{ amountMinor: 4n, clawedMinor: 4n }]);
            expect(p3.sellerCashbackLedger.returns.map((r) => r.amount)).toEqual([4n]);
          });

          it('counts only refunds that succeeded: a pending one takes nothing back yet (Hassan L-9)', async () => {
            const facts = await credited();
            // R1 (pending) gave back 4000, R2 (succeeded) 1000: only R2's goods count.
            p3.orderFacts.add({
              ...facts,
              goodsPaid: money(5000n, currency),
              goodsKeptSettled: money(9000n, currency),
            });
            expect((await refund(facts, REFUND_2)).ok).toBe(true);
            expect(clawbacks()).toMatchObject([{ refundId: REFUND_2, amountMinor: 40n }]);
          });

          it('takes nothing back from a cashback with no recorded basis', async () => {
            const facts = await credited();
            const credit = credits()[0]!;
            p3.credits.rows.set(credit.id, { ...credit, earnedOn: null });
            p3.orderFacts.add({ ...facts, goodsPaid: money(0n, currency) });
            expect(await refund(facts, REFUND_1)).toEqual({
              ok: true,
              value: { outcome: 'nothing' },
            });
            expect(p3.walletCredit.clawbacks.size).toBe(0);
          });

          it('settles with nothing taken when the wallet refuses for good', async () => {
            const facts = await credited();
            p3.orderFacts.add({ ...facts, goodsPaid: money(6000n, currency) });
            p3.walletCredit.failure = { retry: false, code: 'wallet.not-found' };
            expect((await refund(facts, REFUND_1)).ok).toBe(true);
            expect(clawbacks()).toMatchObject([
              { status: 'DONE', clawedMinor: 0n, walletJournalId: null },
            ]);
            expect(p3.sellerCashbackLedger.returns).toHaveLength(0);
          });

          if (confirmed) {
            it('takes back the platform’s cashback too, with nothing for a seller', async () => {
              await adminCreate(cashback({ testMode: false }));
              const facts = deliverHeld(1);
              await run(facts);
              clock.advance(Temporal.Duration.from(HOLD));
              await grantDue();
              expect(credits()[0]).toMatchObject({ status: 'GRANTED', amountMinor: 500n });
              p3.orderFacts.add({ ...facts, goodsPaid: money(5000n, currency) });
              expect((await refund(facts, REFUND_1)).ok).toBe(true);
              expect(clawbacks()).toMatchObject([{ amountMinor: 250n, clawedMinor: 250n }]);
              expect(p3.sellerCashbackLedger.returns).toHaveLength(0);
            });
          }

          it('does nothing without a credited cashback, for another order, and refuses malformed ids', async () => {
            const facts = deliverOrder(1, REFERRER, 10000n);
            expect(await refund(facts, REFUND_1)).toEqual({
              ok: true,
              value: { outcome: 'nothing' },
            });
            const paid = await credited();
            expect(await refund({ ...paid, orderId: id<'Order'>(0x0dff) }, REFUND_2)).toEqual({
              ok: true,
              value: { outcome: 'nothing' },
            });
            expect(
              await make(ClawBackOnRefund).execute(system, {
                delivery: delivery(),
                orderId: paid.orderId,
                sellerOrderId: paid.sellerOrderId,
                refundId: 'x',
              }),
            ).toEqual({ ok: false, error: { code: 'validation.failed' } });
          });

          it('is for the system only', async () => {
            const facts = await credited();
            const result = await make(ClawBackOnRefund).execute(admin(), {
              delivery: delivery(),
              orderId: facts.orderId,
              sellerOrderId: facts.sellerOrderId,
              refundId: REFUND_1,
            });
            expect(result.ok).toBe(false);
          });
        });

        it('gives a seller’s cashback nothing when the order was not flagged exclusive at checkout', async () => {
          await sellerCashback();
          p3.exclusiveCustomers.sellers.set(REFERRER, SELLER);
          await run(deliverOrder(1, REFERRER, 10000n, { exclusiveSeller: false }));
          expect(credits()).toHaveLength(0);
        });
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
        const result = await make(ApplyReferralCode).execute(customerOf(who), {
          code: referrerCode,
        });
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
        expect(credits().every((c) => c.status === (confirmed ? 'GRANTED' : 'RECORDED'))).toBe(
          true,
        );
        // A test-mode run decides nothing about the referral: it stays open for a real program.
        expect([...p3.referrals.rows.values()][0]).toMatchObject(
          confirmed
            ? { status: 'QUALIFIED', qualifyingOrderId: facts.orderId }
            : { status: 'PENDING', qualifyingOrderId: null },
        );
      });

      it('the same event twice, and a later order, credit each person once', async () => {
        await applyAs(NEWBIE);
        const facts = deliverOrder(1, NEWBIE, 5000n);
        const d = delivery();
        await qualify(facts, d);
        expect(await qualify(facts, d)).toEqual({
          ok: true,
          value: { outcome: 'already-handled' },
        });
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
        expect(states).toEqual(
          confirmed
            ? [
                ['QUALIFIED', null],
                ['QUALIFIED', null],
                ['REJECTED', 'CAP_REACHED'],
              ]
            : // Test mode qualifies nobody, so nobody counts toward the cap.
              [
                ['PENDING', null],
                ['PENDING', null],
                ['PENDING', null],
              ],
        );
        expect(credits()).toHaveLength(confirmed ? 4 : 6);
      });

      it('rejects a referral the budget cannot cover whole', async () => {
        const [made] = [...promotions.records.values()];
        promotions.records.set(made!.id, { ...made!, budgetMinor: 1500n });
        await applyAs(NEWBIE);
        expect(await qualify(deliverOrder(1, NEWBIE, 5000n))).toEqual({
          ok: true,
          value: { outcome: confirmed ? 'rejected' : 'pending' },
        });
        // Test mode never rejects: it notes nothing and leaves the referral open.
        expect([...p3.referrals.rows.values()][0]).toMatchObject(
          confirmed
            ? { status: 'REJECTED', rejectReason: 'BUDGET_EXHAUSTED' }
            : { status: 'PENDING', rejectReason: null },
        );
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

    describe('credits reserved earlier, test mode, and the Market limits at issue time', () => {
      const cashRun = (facts: Parameters<typeof input>[0], d?: EventDelivery) =>
        make(CashbackOnDelivery).execute(system, input(facts, d));
      const qualify = (facts: Parameters<typeof input>[0], d?: EventDelivery) =>
        make(QualifyReferralOnDelivery).execute(system, input(facts, d));
      const mineCode = async () => {
        const mine = await make(ViewMyReferral).execute(customerOf(REFERRER), {});
        if (!mine.ok) throw new Error('view failed');
        return mine.value.code;
      };
      const applyAs = async (who: Id<'Account'>, code: string) => {
        p3.orderHistory.lastOrder.set(who, null);
        const result = await make(ApplyReferralCode).execute(customerOf(who), { code });
        expect(result.ok).toBe(true);
      };
      const programOf = (type: string) =>
        [...promotions.records.values()].find((record) => record.type === type)!;
      const change = (type: string, over: Record<string, unknown>) => {
        const record = programOf(type);
        promotions.records.set(record.id, { ...record, ...over });
      };
      /** The next settle throws once, as a crash after the wallet call and before the settlement. */
      const crashOnSettle = () => {
        const original = p3.credits.settle.bind(p3.credits);
        let armed = true;
        p3.credits.settle = (...args: Parameters<typeof original>) => {
          if (!armed) return original(...args);
          armed = false;
          return Promise.reject(new Error('crash after the wallet call'));
        };
      };
      /** The next inbox write throws once, as a crash before the event is recorded as handled. */
      const crashOnInbox = () => {
        const original = units.runOnce;
        let armed = true;
        units.runOnce = ((...args: Parameters<typeof original>) => {
          if (!armed) return original(...args);
          armed = false;
          return Promise.reject(new Error('crash before the inbox'));
        }) as typeof original;
      };

      describe('a credit that is already reserved is always finished', () => {
        if (confirmed) {
          it('cashback: a crash after the wallet call, the switch turned off, then the redelivery, grants it', async () => {
            await adminCreate(cashback({ testMode: false }));
            const facts = deliverOrder(1, REFERRER, 10000n);
            const d = delivery();
            crashOnSettle();
            await expect(cashRun(facts, d)).rejects.toThrow('crash after the wallet call');
            expect(credits().map((c) => c.status)).toEqual(['PENDING']);
            expect(p3.walletCredit.grants).toHaveLength(1);

            await make(SetPromotionsStatus).execute(admin(), { status: 'off' });
            expect(await cashRun(facts, d)).toEqual({ ok: true, value: { outcome: 'issued' } });
            expect(credits().map((c) => c.status)).toEqual(['GRANTED']);
            // The wallet answered the first journal again: one credit, not two.
            expect(p3.walletCredit.grants).toHaveLength(1);
            expect(p3.walletCredit.calls).toBe(2);
            // And a new reservation is still gated on the switch.
            expect(await cashRun(deliverOrder(2, REFERRER, 10000n))).toEqual({
              ok: true,
              value: { outcome: 'nothing' },
            });
            expect(credits()).toHaveLength(1);
          });

          it.each([
            ['paused', { status: 'PAUSED' }],
            ['ended', { endsAt: T0.subtract({ hours: 1 }) }],
          ])(
            'cashback: the program %s between the reservation and the retry, it is settled',
            async (_name, over) => {
              await adminCreate(cashback({ testMode: false }));
              const facts = deliverOrder(1, REFERRER, 10000n);
              p3.walletCredit.failure = { retry: true, code: 'wallet.unavailable' };
              expect(await cashRun(facts)).toEqual({
                ok: false,
                error: { code: 'promotions.try-again' },
              });
              change('CASHBACK', over);
              expect(await cashRun(facts)).toEqual({ ok: true, value: { outcome: 'issued' } });
              expect(credits().map((c) => c.status)).toEqual(['GRANTED']);
              // A new order earns nothing from the stopped program.
              await cashRun(deliverOrder(2, REFERRER, 10000n));
              expect(credits()).toHaveLength(1);
            },
          );

          it('referral: a crash after the wallet calls, the switch turned off, then the redelivery, grants both', async () => {
            await adminCreate(referral({ testMode: false }));
            await applyAs(NEWBIE, await mineCode());
            const facts = deliverOrder(1, NEWBIE, 5000n);
            const d = delivery();
            crashOnSettle();
            await expect(qualify(facts, d)).rejects.toThrow('crash after the wallet call');
            expect(credits().map((c) => c.status)).toEqual(['PENDING', 'PENDING']);
            expect([...p3.referrals.rows.values()][0]!.status).toBe('QUALIFIED');

            await make(SetPromotionsStatus).execute(admin(), { status: 'off' });
            expect(await qualify(facts, d)).toEqual({ ok: true, value: { outcome: 'issued' } });
            expect(credits().map((c) => c.status)).toEqual(['GRANTED', 'GRANTED']);
            expect(p3.walletCredit.grants).toHaveLength(2);
          });

          it.each([
            ['paused', { status: 'PAUSED' }],
            ['ended', { endsAt: T0.subtract({ hours: 1 }) }],
          ])(
            'referral: the program %s between the reservation and the retry, both are settled',
            async (_name, over) => {
              await adminCreate(referral({ testMode: false }));
              await applyAs(NEWBIE, await mineCode());
              const facts = deliverOrder(1, NEWBIE, 5000n);
              p3.walletCredit.failure = { retry: true, code: 'wallet.unavailable' };
              expect(await qualify(facts)).toEqual({
                ok: false,
                error: { code: 'promotions.try-again' },
              });
              change('REFERRAL', over);
              expect(await qualify(facts)).toEqual({ ok: true, value: { outcome: 'issued' } });
              expect(credits().map((c) => c.status)).toEqual(['GRANTED', 'GRANTED']);
            },
          );

          it('settles the first credit again and finishes the second after a partial grant', async () => {
            await adminCreate(referral({ testMode: false }));
            await applyAs(NEWBIE, await mineCode());
            const facts = deliverOrder(1, NEWBIE, 5000n);
            // The referrer's credit goes through; the new customer's wallet is unavailable.
            p3.walletCredit.failWhen = (request) =>
              request.idempotencyKey.includes('referee')
                ? { retry: true, code: 'wallet.unavailable' }
                : null;
            expect(await qualify(facts)).toEqual({
              ok: false,
              error: { code: 'promotions.try-again' },
            });
            expect(p3.walletCredit.grants).toHaveLength(1);
            p3.walletCredit.failWhen = null;
            expect(await qualify(facts)).toEqual({ ok: true, value: { outcome: 'issued' } });
            expect(credits().map((c) => c.status)).toEqual(['GRANTED', 'GRANTED']);
            // The referrer was not paid twice: the wallet answered its first journal again.
            expect(p3.walletCredit.grants).toHaveLength(2);
            expect(new Set(p3.walletCredit.grants.map((g) => g.idempotencyKey)).size).toBe(2);
          });

          it.each([
            ['idempotency.key-reused'],
            ['wallet.customer-not-found'],
            ['wallet.not-found'],
          ])(
            'a final wallet refusal (%s) fails the credit, releases the budget and is reported',
            async (code) => {
              await adminCreate(cashback({ testMode: false }));
              const facts = deliverOrder(1, REFERRER, 10000n);
              p3.walletCredit.failure = { retry: false, code };
              expect(await cashRun(facts)).toEqual({ ok: true, value: { outcome: 'failed' } });
              expect(credits()[0]).toMatchObject({ status: 'FAILED', failureCode: code });
              expect(await p3.credits.reservedTotal(market, credits()[0]!.promotionId)).toBe(0n);
              // A new event for the same order finds the failed credit and reports it as failed.
              expect(await cashRun(facts)).toEqual({ ok: true, value: { outcome: 'failed' } });
              expect(p3.walletCredit.calls).toBe(1);
            },
          );
        }

        it('recovers from a crash in test mode (cashback): the note is kept once', async () => {
          await adminCreate(cashback({ testMode: true }));
          const facts = deliverOrder(1, REFERRER, 10000n);
          const d = delivery();
          crashOnInbox();
          await expect(cashRun(facts, d)).rejects.toThrow('crash before the inbox');
          expect(credits().map((c) => c.status)).toEqual(['RECORDED']);
          expect(await cashRun(facts, d)).toEqual({ ok: true, value: { outcome: 'recorded' } });
          expect(credits()).toHaveLength(1);
          expect(p3.walletCredit.calls).toBe(0);
        });

        it('recovers from a crash in test mode (referral): the notes are kept once and the referral stays open', async () => {
          await adminCreate(referral({ testMode: true }));
          await applyAs(NEWBIE, await mineCode());
          const facts = deliverOrder(1, NEWBIE, 5000n);
          const d = delivery();
          crashOnInbox();
          await expect(qualify(facts, d)).rejects.toThrow('crash before the inbox');
          expect(credits()).toHaveLength(2);
          expect(await qualify(facts, d)).toEqual({ ok: true, value: { outcome: 'recorded' } });
          expect(credits()).toHaveLength(2);
          expect([...p3.referrals.rows.values()][0]!.status).toBe('PENDING');
          expect(p3.walletCredit.calls).toBe(0);
        });
      });

      describe('test mode', () => {
        it('records the intended cashback only when no real promotion applies, and never displaces a real one', async () => {
          const cap = rules.cashback!;
          await adminCreate(
            cashback({
              name: 'Real',
              testMode: true,
              reward: { kind: 'PERCENT', bps: cap.maxBps / 2 },
            }),
          );
          await adminCreate(
            cashback({
              name: 'Test',
              testMode: true,
              reward: { kind: 'PERCENT', bps: cap.maxBps },
            }),
          );
          const real = [...promotions.records.values()].find((r) => r.name === 'Real')!;
          const test = [...promotions.records.values()].find((r) => r.name === 'Test')!;
          promotions.records.set(real.id, { ...real, testMode: false });
          const facts = deliverOrder(1, REFERRER, 10000n);
          await cashRun(facts);
          if (confirmed) {
            // The test promotion pays more, but the real one is the one that applies.
            expect(credits()).toHaveLength(1);
            expect(credits()[0]).toMatchObject({
              promotionId: real.id,
              status: 'GRANTED',
              amountMinor: (10000n * BigInt(cap.maxBps / 2)) / 10000n,
            });
          } else {
            // The real promotion earns nothing while the tax ruling is open, so the note is made.
            expect(credits()).toHaveLength(1);
            expect(credits()[0]).toMatchObject({ promotionId: test.id, status: 'RECORDED' });
          }
        });

        if (confirmed) {
          it('does not count a note toward the per-order cap or the limits, and a real credit follows it', async () => {
            // Only a test-mode promotion at first: the order is noted.
            await adminCreate(cashback({ name: 'Test', testMode: true }));
            const order = id<'Order'>(0x0eee);
            const first = deliverOrder(1, REFERRER, 10000n, { orderId: order });
            const d = delivery();
            expect(await cashRun(first, d)).toEqual({ ok: true, value: { outcome: 'recorded' } });
            // A real promotion starts; the same seller order comes again in a new event.
            await adminCreate(
              cashback({ name: 'Real', testMode: false, capMinor: '700', maxUsesPerCustomer: 2 }),
            );
            expect(await cashRun(first)).toEqual({ ok: true, value: { outcome: 'issued' } });
            expect(
              credits()
                .map((c) => c.status)
                .sort(),
            ).toEqual(['GRANTED', 'RECORDED']);
            // The note was not money: the real cap of 700 is whole for the next seller order.
            expect(await p3.credits.creditedForOrder(market, order, 'CASHBACK')).toBe(500n);
            await cashRun(deliverOrder(2, REFERRER, 10000n, { orderId: order }));
            expect(
              credits()
                .filter((c) => c.status === 'GRANTED')
                .map((c) => c.amountMinor)
                .sort(),
            ).toEqual([200n, 500n]);
          });
        }

        it('qualifies nobody and counts toward no referrer cap, so a real program can still reward the referee', async () => {
          await adminCreate(referral({ testMode: true }));
          const code = await mineCode();
          const people = [id<'Account'>(0xd1), id<'Account'>(0xd2), id<'Account'>(0xd3)];
          for (const [index, who] of people.entries()) {
            await applyAs(who, code);
            expect(await qualify(deliverOrder(index + 1, who, 5000n))).toEqual({
              ok: true,
              value: { outcome: 'recorded' },
            });
          }
          // Three referrals under a cap of two: none was rejected, none counts as rewarded.
          expect([...p3.referrals.rows.values()].map((r) => r.status)).toEqual([
            'PENDING',
            'PENDING',
            'PENDING',
          ]);
          expect(credits().every((c) => c.status === 'RECORDED')).toBe(true);
          expect(credits()).toHaveLength(6);
          const view = await make(ViewMyReferral).execute(customerOf(REFERRER), {});
          expect(view.ok && view.value).toMatchObject({ pending: 3, qualified: 0 });

          // The program leaves test mode: the first referee's next order is rewarded for real.
          change('REFERRAL', { testMode: false });
          const next = deliverOrder(4, people[0]!, 6000n);
          const result = await qualify(next);
          if (confirmed) {
            expect(result).toEqual({ ok: true, value: { outcome: 'issued' } });
            expect(
              [...p3.referrals.rows.values()].find((r) => r.refereeAccountId === people[0]),
            ).toMatchObject({ status: 'QUALIFIED', qualifyingSellerOrderId: next.sellerOrderId });
            const real = credits().filter((c) => c.status === 'GRANTED');
            expect(real.map((c) => [c.kind, c.recipientAccountId, c.amountMinor]).sort()).toEqual(
              [
                ['REFEREE_REWARD', people[0], 800n],
                ['REFERRER_REWARD', REFERRER, 1000n],
              ].sort(),
            );
            expect(p3.walletCredit.grants).toHaveLength(2);
          } else {
            // The tax ruling is still open: a real program earns nothing, the referral waits.
            expect(result).toEqual({ ok: true, value: { outcome: 'pending' } });
            expect(p3.walletCredit.calls).toBe(0);
          }
        });
      });

      describe('the Market limits at issue time', () => {
        it('clamps the cashback to the current percent and per-order cap', async () => {
          const limits = rules.cashback!;
          await adminCreate(cashback({ testMode: true }));
          // The promotion was made under wider limits than the Market has now.
          change('CASHBACK', {
            reward: { kind: 'PERCENT', bps: limits.maxBps * 2 },
            capMinor: limits.maxCapMinor * 2n,
            budgetMinor: null,
          });
          const goods = (limits.maxCapMinor * 40000n) / BigInt(limits.maxBps);
          await cashRun(deliverOrder(1, REFERRER, goods));
          // The percent is clamped first (half of what the promotion says), then the cap.
          const byPercent = (goods * BigInt(limits.maxBps)) / 10000n;
          expect(credits()[0]!.amountMinor).toBe(
            byPercent < limits.maxCapMinor ? byPercent : limits.maxCapMinor,
          );
          expect(credits()[0]!.amountMinor <= limits.maxCapMinor).toBe(true);
          expect(credits()[0]!.amountMinor < (goods * BigInt(limits.maxBps * 2)) / 10000n).toBe(
            true,
          );
        });

        it('clamps both referral credits to the current maximum reward', async () => {
          const limits = rules.referral!;
          await adminCreate(referral({ testMode: true }));
          change('REFERRAL', {
            reward: { kind: 'FIXED', amount: limits.maxRewardMinor + 700n },
            refereeRewardMinor: limits.maxRewardMinor + 300n,
            budgetMinor: null,
          });
          await applyAs(NEWBIE, await mineCode());
          await qualify(deliverOrder(1, NEWBIE, 5000n));
          expect(credits().map((c) => c.amountMinor)).toEqual([
            limits.maxRewardMinor,
            limits.maxRewardMinor,
          ]);
        });
      });

      describe('referral timing', () => {
        const windowHours = () => 24 * rules.referral!.qualifyWithinDays;
        const exactly = () => Temporal.Duration.from({ hours: windowHours() });
        const justBefore = () =>
          Temporal.Duration.from({
            hours: windowHours() - 1,
            minutes: 59,
            seconds: 59,
            milliseconds: 999,
          });

        beforeEach(async () => {
          await adminCreate(referral({ testMode: true }));
        });

        it('expires at the boundary instant (now equals the expiry) and not a millisecond before', async () => {
          const code = await mineCode();
          await applyAs(NEWBIE, code);
          await applyAs(NEWBIE_2, code);
          clock.advance(justBefore());
          expect(await qualify(deliverOrder(1, NEWBIE, 5000n))).toEqual({
            ok: true,
            value: { outcome: 'recorded' },
          });
          clock.advance(Temporal.Duration.from({ milliseconds: 1 }));
          expect(clock.now()).toEqual(T0.add(exactly()));
          expect(await qualify(deliverOrder(2, NEWBIE_2, 5000n))).toEqual({
            ok: true,
            value: { outcome: 'expired' },
          });
          expect(
            [...p3.referrals.rows.values()].find((r) => r.refereeAccountId === NEWBIE_2)!.status,
          ).toBe('EXPIRED');
        });

        it('counts a referral as pending only while its window is open', async () => {
          await applyAs(NEWBIE, await mineCode());
          const view = async () => {
            const result = await make(ViewMyReferral).execute(customerOf(REFERRER), {});
            if (!result.ok) throw new Error('view failed');
            return result.value.pending;
          };
          expect(await view()).toBe(1);
          clock.advance(justBefore());
          expect(await view()).toBe(1);
          clock.advance(Temporal.Duration.from({ milliseconds: 1 }));
          expect(await view()).toBe(0);
        });

        it('checks eligibility before it looks the code up, so it does not say which codes exist', async () => {
          const code = await mineCode();
          const notEligible = { ok: false, error: { code: 'promotions.referral-not-eligible' } };
          await applyAs(NEWBIE, code);
          // Already referred: an unknown code gets the same answer as a real one.
          const unknown = 'A'.repeat(code.length);
          expect(
            await make(ApplyReferralCode).execute(customerOf(NEWBIE), { code: unknown }),
          ).toEqual(notEligible);
          expect(await make(ApplyReferralCode).execute(customerOf(NEWBIE), { code })).toEqual(
            notEligible,
          );
          // A customer who ordered before: the same.
          p3.orderHistory.lastOrder.set(NEWBIE_2, T0.subtract({ hours: 24 * 400 }));
          expect(
            await make(ApplyReferralCode).execute(customerOf(NEWBIE_2), { code: unknown }),
          ).toEqual(notEligible);
          // An eligible customer still gets not-found for an unknown code.
          const fresh = id<'Account'>(0xd9);
          p3.orderHistory.lastOrder.set(fresh, null);
          expect(
            await make(ApplyReferralCode).execute(customerOf(fresh), { code: unknown }),
          ).toEqual({
            ok: false,
            error: { code: 'promotions.not-found' },
          });
        });
      });
    });
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
        grantAfter: null,
        earnedOn: null,
      });
      const listed = await make(ListPromotionCredits).execute(admin(), { promotionId: made.id });
      expect(listed.ok && listed.value.items).toHaveLength(1);
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

    it('pages with a keyset cursor without gaps or repeats, and reads while the switch is off', async () => {
      const made = await adminCreate(cashback());
      for (let n = 1; n <= 5; n += 1) {
        await p3.credits.insert(market, {
          id: id<'PromotionCredit'>(0xc20 + n),
          promotionId: made.id,
          kind: 'CASHBACK',
          recipientAccountId: REFERRER,
          orderId: id<'Order'>(0x0c00 + n),
          sourceKind: 'SELLER_ORDER',
          sourceId: `0199${n}`,
          amountMinor: BigInt(n),
          currency,
          status: 'RECORDED',
          failureCode: null,
          walletJournalId: null,
          idempotencyKey: `promotions:cashback:page000${n}`,
          // Three share an instant: the id breaks the tie.
          createdAt: T0.add({ hours: n <= 3 ? 1 : n }),
          settledAt: T0,
          grantAfter: null,
          earnedOn: null,
        });
      }
      await make(SetPromotionsStatus).execute(admin(), { status: 'off' });
      const seen: bigint[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await make(ListPromotionCredits).execute(admin(), {
          promotionId: made.id,
          limit: 2,
          ...(cursor === undefined ? {} : { cursor }),
        });
        if (!page.ok) throw new Error(`list failed: ${JSON.stringify(page.error)}`);
        seen.push(...page.value.items.map((c) => c.amountMinor));
        cursor = page.value.nextCursor ?? undefined;
        pages += 1;
      } while (cursor !== undefined && pages < 10);
      expect(pages).toBe(3);
      expect(seen).toEqual([5n, 4n, 3n, 2n, 1n]);
      expect(
        fields(
          await make(ListPromotionCredits).execute(admin(), {
            promotionId: made.id,
            cursor: 'not-a-cursor!',
          }),
        ),
      ).toContain('cursor:value');
    });

    it("lists one customer's credits across promotions for the customer page, newest first and in pages", async () => {
      const first = await adminCreate(cashback());
      const second = await adminCreate(cashback());
      const credit = (n: number, promotionId: typeof first.id, recipient: Id<'Account'>) =>
        p3.credits.insert(market, {
          id: id<'PromotionCredit'>(0xd20 + n),
          promotionId,
          kind: 'CASHBACK',
          recipientAccountId: recipient,
          orderId: id<'Order'>(0x0d00 + n),
          sourceKind: 'SELLER_ORDER',
          sourceId: `0299${n}`,
          amountMinor: BigInt(n),
          currency,
          status: 'GRANTED',
          failureCode: null,
          walletJournalId: null,
          idempotencyKey: `promotions:cashback:cust000${n}`,
          createdAt: T0.add({ hours: n }),
          settledAt: T0,
          grantAfter: null,
          earnedOn: null,
        });
      await credit(1, first.id, REFERRER);
      await credit(2, second.id, REFERRER);
      await credit(3, first.id, REFERRER);
      await credit(4, first.id, NEWBIE);
      expect(ListCustomerPromotionCredits.access.rule).toEqual({
        kind: 'permissions',
        allOf: ['promotions.promotion.view'],
      });
      const page = await make(ListCustomerPromotionCredits).execute(admin(), {
        customerAccountId: REFERRER,
        limit: 2,
      });
      if (!page.ok) throw new Error('list failed');
      expect(page.value.items.map((c) => c.amountMinor)).toEqual([3n, 2n]);
      const rest = await make(ListCustomerPromotionCredits).execute(admin(), {
        customerAccountId: REFERRER,
        limit: 2,
        cursor: page.value.nextCursor!,
      });
      expect(rest.ok && rest.value.items.map((c) => c.amountMinor)).toEqual([1n]);
      expect(rest.ok && rest.value.nextCursor).toBeNull();
      const nobody = await make(ListCustomerPromotionCredits).execute(admin(), {
        customerAccountId: NEWBIE_2,
      });
      expect(nobody.ok && nobody.value.items).toEqual([]);
      expect(
        fields(
          await make(ListCustomerPromotionCredits).execute(admin(), { customerAccountId: 'x' }),
        ),
      ).toContain('customerAccountId:value');
      expect(
        await make(ListCustomerPromotionCredits).execute(actingAs(admin()), {
          customerAccountId: REFERRER,
        }),
      ).toMatchObject({ ok: false });
    });

    it("lists the promotions one customer's orders used, newest first and in pages, never an order's head row (phase 2b, item e)", async () => {
      const made = await adminCreate(group());
      p3.redemptions.names.set(made.id, 'Welcome back');
      const row = (
        n: number,
        over: Partial<RedemptionRecord> & Pick<RedemptionRecord, 'customerAccountId'>,
      ): RedemptionRecord => ({
        id: id<'Redemption'>(0x900 + n),
        orderId: id<'Order'>(0x800 + n),
        promotionKey: made.id,
        promotionId: made.id,
        kind: 'PROMOTION',
        codeHash: null,
        currency,
        amount: BigInt(n * 100),
        sellerShare: 0n,
        platformShare: BigInt(n * 100),
        units: null,
        budgetMonth: null,
        status: 'CONFIRMED',
        releaseReason: null,
        reservedAt: T0.add({ hours: n }),
        confirmedAt: T0.add({ hours: n + 1 }),
        releasedAt: null,
        ...over,
      });
      await p3.redemptions.insertMany(market, [
        row(1, { customerAccountId: REFERRER }),
        row(2, {
          customerAccountId: REFERRER,
          promotionKey: 'first-order',
          promotionId: null,
          kind: 'FIRST_ORDER',
          status: 'RESERVED',
          confirmedAt: null,
          codeHash: 'h',
        }),
        row(3, {
          customerAccountId: REFERRER,
          status: 'RELEASED',
          releaseReason: 'ORDER_CANCELLED',
          releasedAt: T0.add({ hours: 5 }),
        }),
        // An order's head row and another customer's row are never listed.
        row(4, {
          customerAccountId: REFERRER,
          promotionKey: 'order',
          promotionId: null,
          kind: 'ORDER',
        }),
        row(5, { customerAccountId: NEWBIE }),
      ]);
      expect(ListCustomerPromotionUsages.access.rule).toEqual({
        kind: 'permissions',
        allOf: ['promotions.promotion.view', 'customers.customers.view'],
      });
      const page = await make(ListCustomerPromotionUsages).execute(admin(), {
        customerAccountId: REFERRER,
        limit: 2,
      });
      if (!page.ok) throw new Error('list failed');
      expect(
        page.value.items.map((u) => [u.record.amount, u.record.status, u.promotionName]),
      ).toEqual([
        [300n, 'RELEASED', 'Welcome back'],
        [200n, 'RESERVED', null],
      ]);
      expect(page.value.items.every((u) => u.record.currency === currency)).toBe(true);
      const rest = await make(ListCustomerPromotionUsages).execute(admin(), {
        customerAccountId: REFERRER,
        limit: 2,
        cursor: page.value.nextCursor!,
      });
      expect(rest.ok && rest.value.items.map((u) => u.record.amount)).toEqual([100n]);
      expect(rest.ok && rest.value.nextCursor).toBeNull();
      const nobody = await make(ListCustomerPromotionUsages).execute(admin(), {
        customerAccountId: NEWBIE_2,
      });
      expect(nobody.ok && nobody.value.items).toEqual([]);
      expect(
        fields(
          await make(ListCustomerPromotionUsages).execute(admin(), {
            customerAccountId: 'x',
            limit: 101,
            cursor: 'not-a-cursor!',
          }),
        ),
      ).toEqual(['customerAccountId:value', 'limit:value', 'cursor:value']);
      // Reads work while promotions are switched off; the acting-as session is refused.
      expect((await make(SetPromotionsStatus).execute(admin(), { status: 'off' })).ok).toBe(true);
      const off = await make(ListCustomerPromotionUsages).execute(admin(), {
        customerAccountId: REFERRER,
      });
      expect(off.ok && off.value.items).toHaveLength(3);
      expect(
        await make(ListCustomerPromotionUsages).execute(actingAs(admin()), {
          customerAccountId: REFERRER,
        }),
      ).toMatchObject({ ok: false });
      expect(
        await make(ListCustomerPromotionUsages).execute(seller(), {
          customerAccountId: REFERRER,
        }),
      ).toMatchObject({ ok: false, error: { code: 'access.denied' } });
      // An admin without the customers view key (or the promotions view key) is refused.
      const asked: unknown[] = [];
      gate = createUseCaseGate(markets, {
        check: (_context, declaration): Promise<AccessDecision> => {
          asked.push(declaration.rule);
          return Promise.resolve({ allowed: false, denial: { code: 'access.denied' } });
        },
      });
      expect(
        await make(ListCustomerPromotionUsages).execute(admin(), {
          customerAccountId: REFERRER,
        }),
      ).toMatchObject({ ok: false, error: { code: 'access.denied' } });
      expect(asked).toEqual([ListCustomerPromotionUsages.access.rule]);
    });
  });
});
