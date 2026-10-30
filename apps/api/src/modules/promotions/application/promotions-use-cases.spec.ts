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
  FakePriceHistory,
  FakeSellerActivity,
  FakeStepUp,
  MemoryFirstOrder,
  MemoryOptIns,
  MemoryPromotions,
  MemoryPromotionsSetting,
  MemoryReviewQueue,
  MemoryThresholds,
} from '../../../../test/support/promotions-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { AccessDecision } from '../../../platform/authz';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PROMOTIONS_AUDIT_ACTIONS } from '../domain/audit';
import { ConfigPromotionsPolicy } from '../infrastructure/config-promotions-policy';
import { PromotionsFacadeImplementation } from '../presentation/promotions.facade';
import type { PromotionsDependencies } from './promotions-dependencies';
import { setOptIn, decideReview } from './review-flow';
import { canPreview } from './quote-flow';
import { setStatus } from './settings-flow';
import { createPromotion } from './write-flow';
import { CheckWasPrice } from './use-cases/check-was-price.use-case';
import { CreateOwnPromotion } from './use-cases/create-own-promotion.use-case';
import { CreatePromotion } from './use-cases/create-promotion.use-case';
import { DecidePromotionReview } from './use-cases/decide-promotion-review.use-case';
import { EditOwnPromotion } from './use-cases/edit-own-promotion.use-case';
import { EditPromotion } from './use-cases/edit-promotion.use-case';
import { ListOwnPromotions } from './use-cases/list-own-promotions.use-case';
import { ListPromotionReviews } from './use-cases/list-promotion-reviews.use-case';
import { ListPromotionsFull } from './use-cases/list-promotions-full.use-case';
import { ListPromotions } from './use-cases/list-promotions.use-case';
import { PauseOwnPromotion } from './use-cases/pause-own-promotion.use-case';
import { PausePromotion } from './use-cases/pause-promotion.use-case';
import { PreviewQuote } from './use-cases/preview-quote.use-case';
import { QuoteDiscounts } from './use-cases/quote-discounts.use-case';
import { ResumeOwnPromotion } from './use-cases/resume-own-promotion.use-case';
import { ResumePromotion } from './use-cases/resume-promotion.use-case';
import { SetCoFundingOptIn } from './use-cases/set-co-funding-opt-in.use-case';
import { SetFirstOrderSettings } from './use-cases/set-first-order-settings.use-case';
import { SetFreeShippingThreshold } from './use-cases/set-free-shipping-threshold.use-case';
import { SetPromotionBudget } from './use-cases/set-promotion-budget.use-case';
import { SetPromotionsStatus } from './use-cases/set-promotions-status.use-case';
import { ViewFirstOrderSettings } from './use-cases/view-first-order-settings.use-case';
import { ViewPromotion } from './use-cases/view-promotion.use-case';
import { ViewPromotionsSettings } from './use-cases/view-promotions-settings.use-case';

// The promotions core in memory on both Market fixtures (AU: step-up at 200 000, new seller under
// 30 days, review above 50%; ZZ: 300 000, 14 days, 40%, its tax ruling confirmed): the switch (off
// by default), who may do what, the review queue, the fresh-code rule, test-mode gating, the
// quote through the switch and the fail-closed adapters. The pure calculation has its own spec; the
// tables' guards have their database spec.

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
const SELLER_2_ACCOUNT = id<'Account'>(0xa2);
const product = (n: number) => id<'Product'>(0x1000 + n);
const unit = (n: number) => ({
  offerId: id<'Offer'>(0x2000 + n),
  variantId: id<'Variant'>(0x3000 + n),
});

const ACTIONS = new Set<string>(PROMOTIONS_AUDIT_ACTIONS.map((a) => a.action));

class RecordingAudit implements AuditWriter {
  readonly entries: AuditEntry[] = [];
  record(_context: CallContext, entry: AuditEntry): Promise<void> {
    if (!ACTIONS.has(entry.action)) throw new Error(`audit: unknown action ${entry.action}`);
    this.entries.push(entry);
    return Promise.resolve();
  }
}

describe.each([['AU'], ['ZZ']] as const)('promotions core in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const config = markets.get(market.marketId);
  const rules = config.promotions!;
  const policy = new ConfigPromotionsPolicy(markets);
  const currency = policy.settings(market)!.currency;
  const DAY = { hours: 24 };

  let clock: FixedClock;
  let promotions: MemoryPromotions;
  let optIns: MemoryOptIns;
  let reviewQueue: MemoryReviewQueue;
  let setting: MemoryPromotionsSetting;
  let firstOrder: MemoryFirstOrder;
  let thresholds: MemoryThresholds;
  let activity: FakeSellerActivity;
  let history: FakePriceHistory;
  let stepUp: FakeStepUp;
  let audit: RecordingAudit;
  let units: FakeUnitOfWork;
  let deps: PromotionsDependencies;
  let gate: ReturnType<typeof createUseCaseGate>;

  const admin = (label = 'admin') =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ADMIN,
        sessionId: id<'Session'>(0x62),
        sellerId: null,
      }),
      `promo-${label}-abcdef`,
    );
  const seller = (sellerId = SELLER, accountId = SELLER_ACCOUNT) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId,
        sessionId: id<'Session'>(0x63),
        sellerId,
      }),
      'promo-seller-abcdef',
    );
  const customer = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'customer',
      accountId: id<'Account'>(0xc1),
      sessionId: id<'Session'>(0x64),
      sellerId: null,
    }),
    'promo-customer-abcdef',
  );
  const system = testCallContext(market, 'system', 'promo-system-abcdef');
  const anonymous = testCallContext(market, 'anonymous', 'promo-anon-abcdef');
  const actingAs = (context: CallContext) =>
    ({
      ...context,
      actor: { ...context.actor, actingAs: { adminAccountId: ADMIN } },
    }) as unknown as CallContext;

  const make = <U>(type: new (g: typeof gate, d: PromotionsDependencies) => U): U =>
    new type(gate, deps);

  beforeEach(() => {
    clock = new FixedClock(T0);
    gate = createUseCaseGate(markets, {
      check: (): Promise<AccessDecision> => Promise.resolve({ allowed: true }),
    });
    promotions = new MemoryPromotions();
    optIns = new MemoryOptIns();
    reviewQueue = new MemoryReviewQueue();
    setting = new MemoryPromotionsSetting();
    firstOrder = new MemoryFirstOrder();
    thresholds = new MemoryThresholds();
    activity = new FakeSellerActivity();
    history = new FakePriceHistory();
    stepUp = new FakeStepUp(() => clock.now());
    audit = new RecordingAudit();
    units = new FakeUnitOfWork();
    deps = {
      unitOfWork: units,
      promotions,
      optIns,
      reviews: reviewQueue,
      settings: setting,
      firstOrder,
      thresholds,
      policy,
      sellerActivity: activity,
      priceHistory: history,
      stepUp,
      audit,
      ids: new SequenceIdGenerator(clock),
      clock,
    };
    // A long-standing seller and a brand-new one.
    activity.since.set(SELLER, T0.subtract({ hours: 24 * 400 }));
    activity.since.set(SELLER_2, T0.subtract({ hours: 24 * 2 }));
  });

  const switchOn = async () => {
    const result = await make(SetPromotionsStatus).execute(admin(), { status: 'active' });
    expect(result.ok).toBe(true);
  };

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
  const platformCart = (extra: Record<string, unknown> = {}) => ({
    type: 'CART_DISCOUNT',
    name: 'Platform cart',
    funding: 'PLATFORM',
    startsAt: startsAt(),
    reward: { kind: 'PERCENT', bps: 500 },
    budgetMinor: '100000',
    // A Market whose tax ruling is open keeps platform money in test mode.
    testMode: !rules.gstRulingConfirmed,
    ...extra,
  });

  describe('the Market switch', () => {
    it('is off until an admin turns it on, and every write is refused meanwhile', async () => {
      const view = await make(ViewPromotionsSettings).execute(admin(), {});
      expect(view.ok && view.value.status).toBe('off');

      const created = await make(CreatePromotion).execute(admin(), platformCart());
      expect(created).toEqual({ ok: false, error: { code: 'promotions.disabled' } });
      const own = await make(CreateOwnPromotion).execute(seller(), sale());
      expect(own).toEqual({ ok: false, error: { code: 'promotions.disabled' } });
      expect(promotions.records.size).toBe(0);
    });

    it('a quote with the switch off is the cart with no discount', async () => {
      const result = await new PromotionsFacadeImplementation(
        make(QuoteDiscounts),
        make(CheckWasPrice),
      ).quote(system, {
        lines: [
          {
            id: 'l1',
            sellerId: SELLER,
            productId: product(1),
            unitPrice: money(10000n, currency),
            quantity: 2,
          },
        ],
        shipping: [],
        code: null,
        isFirstOrder: true,
        testMode: false,
        orderCommission: money(1000n, currency),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.enabled).toBe(false);
      expect(result.value.applied).toEqual([]);
      expect(result.value.totals.goodsDiscount).toBe(0n);
    });

    it('is moved by an admin only, audited, idempotent, and refused in an acting-as session', async () => {
      expect(await setStatus(deps, actingAs(admin()), { status: 'active' })).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(await make(SetPromotionsStatus).execute(admin(), { status: 'maybe' })).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
      await switchOn();
      await switchOn();
      expect(audit.entries.map((e) => e.action)).toEqual(['promotions.market-status.changed']);
      expect(setting.row?.status).toBe('active');
    });
  });

  describe('admin promotions', () => {
    beforeEach(switchOn);

    it('creates a platform promotion, audited, and lists it with and without the cost', async () => {
      const created = await make(CreatePromotion).execute(admin(), platformCart());
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.value.status).toBe('ACTIVE');
      expect(audit.entries.at(-1)?.action).toBe('promotions.promotion.created');

      const full = await make(ListPromotionsFull).execute(admin(), {});
      expect(full.ok && full.value.map((p) => p.id)).toEqual([created.value.id]);
      const usage = await make(ListPromotions).execute(admin(), {});
      expect(usage.ok).toBe(true);
      if (!usage.ok) return;
      // A Viewer's view carries usage counts only: no budget, no cap, no cost.
      expect(Object.keys(usage.value[0]!)).not.toEqual(expect.arrayContaining(['budgetMinor']));
      expect(
        JSON.stringify(usage.value, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}` : v)),
      ).not.toContain('100000');
    });

    it('refuses a platform promotion without a budget, and a seller type from an admin', async () => {
      const noBudget = await make(CreatePromotion).execute(
        admin(),
        platformCart({ budgetMinor: undefined }),
      );
      expect(noBudget).toMatchObject({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'budgetMinor', code: 'required' }] },
      });
      const wrongType = await make(CreatePromotion).execute(admin(), sale());
      expect(wrongType).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    });

    it('refuses an acting-as admin and a non-admin', async () => {
      expect(await createPromotion(deps, actingAs(admin()), platformCart(), 'admin')).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(await make(CreatePromotion).execute(seller(), platformCart())).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(await make(CreatePromotion).execute(customer, platformCart())).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(promotions.records.size).toBe(0);
    });

    it('keeps platform money in test mode while the tax ruling is open', async () => {
      const live = await make(CreatePromotion).execute(admin(), platformCart({ testMode: false }));
      if (rules.gstRulingConfirmed) expect(live.ok).toBe(true);
      else {
        expect(live).toMatchObject({
          ok: false,
          error: { code: 'validation.failed', fields: [{ path: 'testMode', code: 'required' }] },
        });
      }
    });

    it('asks for a fresh code above the Market step-up amount, and spends it once', async () => {
      const big = platformCart({
        budgetMinor: String(BigInt(rules.platformBudgetStepUpMinor) + 1n),
      });
      const refused = await make(CreatePromotion).execute(admin(), big);
      expect(refused).toEqual({
        ok: false,
        error: {
          code: 'second-factor.required',
          actionKey: 'promotions.platform-funding.approve',
        },
      });
      expect(promotions.records.size).toBe(0);

      stepUp.fresh = true;
      const created = await make(CreatePromotion).execute(admin(), big);
      expect(created.ok).toBe(true);
      expect(stepUp.spent).toEqual(['promotions.platform-funding.approve']);
      expect(Object.keys(audit.entries.at(-1)?.after ?? {})).toContain('stepUpSessionId');
    });

    it('needs a fresh code to raise a budget past the step-up amount, not to lower one', async () => {
      const created = await make(CreatePromotion).execute(admin(), platformCart());
      if (!created.ok) throw new Error('create failed');
      const above = String(BigInt(rules.platformBudgetStepUpMinor) + 5n);
      expect(
        await make(SetPromotionBudget).execute(admin(), {
          promotionId: created.value.id,
          budgetMinor: above,
        }),
      ).toMatchObject({ ok: false, error: { code: 'second-factor.required' } });
      stepUp.fresh = true;
      const raised = await make(SetPromotionBudget).execute(admin(), {
        promotionId: created.value.id,
        budgetMinor: above,
      });
      expect(raised.ok).toBe(true);
      const lowered = await make(SetPromotionBudget).execute(admin(), {
        promotionId: created.value.id,
        budgetMinor: '5000',
      });
      expect(lowered.ok).toBe(true);
      expect(audit.entries.map((e) => e.action)).toContain('promotions.promotion.budget-changed');
    });

    it('needs a fresh code to flag a special campaign', async () => {
      const special = platformCart({ specialCampaign: true });
      expect(await make(CreatePromotion).execute(admin(), special)).toMatchObject({
        ok: false,
        error: { code: 'second-factor.required' },
      });
      stepUp.fresh = true;
      const created = await make(CreatePromotion).execute(admin(), special);
      expect(created.ok && created.value.specialCampaign).toBe(true);
    });

    it('keeps a promotion code unique in the Market', async () => {
      const coded = platformCart({ type: 'CART_CODE', code: 'WELCOME-10' });
      expect((await make(CreatePromotion).execute(admin(), coded)).ok).toBe(true);
      expect(await make(CreatePromotion).execute(admin(), coded)).toEqual({
        ok: false,
        error: { code: 'promotions.code-taken' },
      });
    });

    it('pauses and resumes, idempotently, with an audit row for each change', async () => {
      const created = await make(CreatePromotion).execute(admin(), platformCart());
      if (!created.ok) throw new Error('create failed');
      const input = { promotionId: created.value.id };
      const paused = await make(PausePromotion).execute(admin(), input);
      expect(paused.ok && paused.value.status).toBe('PAUSED');
      await make(PausePromotion).execute(admin(), input);
      const resumed = await make(ResumePromotion).execute(admin(), input);
      expect(resumed.ok && resumed.value.status).toBe('ACTIVE');
      expect(audit.entries.map((e) => e.action).filter((a) => a.endsWith('paused'))).toHaveLength(
        1,
      );
      expect(await make(ViewPromotion).execute(admin(), { promotionId: 'nope' })).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
    });

    it('edits a platform promotion but never its type, funding or code', async () => {
      const created = await make(CreatePromotion).execute(admin(), platformCart());
      if (!created.ok) throw new Error('create failed');
      const edited = await make(EditPromotion).execute(admin(), {
        ...platformCart({ name: 'Renamed', reward: { kind: 'PERCENT', bps: 700 } }),
        promotionId: created.value.id,
      });
      expect(edited.ok && edited.value.name).toBe('Renamed');
      const retyped = await make(EditPromotion).execute(admin(), {
        ...platformCart({ type: 'CART_CODE', code: 'ABCD-1234' }),
        promotionId: created.value.id,
      });
      expect(retyped).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    });
  });

  describe('seller promotions', () => {
    beforeEach(switchOn);

    it('goes live at once for a long-standing seller with a modest discount', async () => {
      const created = await make(CreateOwnPromotion).execute(seller(), sale());
      expect(created.ok && created.value.status).toBe('ACTIVE');
      // It applies at once; a post-publication check is queued for an admin to look at later.
      expect([...reviewQueue.entries.values()].map((e) => e.reason)).toEqual(['POST_REVIEW']);
      expect(audit.entries.at(-1)?.action).toBe('promotions.promotion.created');
    });

    it('waits for an admin when the seller is new, and when the seller age is unknown', async () => {
      const fresh = await make(CreateOwnPromotion).execute(
        seller(SELLER_2, SELLER_2_ACCOUNT),
        sale(),
      );
      expect(fresh.ok && fresh.value.status).toBe('PENDING_APPROVAL');
      expect([...reviewQueue.entries.values()][0]?.reason).toBe('NEW_SELLER');

      // An unknown age (never approved, or the read failed) is treated as new (fail closed).
      deps = { ...deps, sellerActivity: { activeSince: () => Promise.resolve(null) } };
      const unknown = await make(CreateOwnPromotion).execute(seller(), sale());
      expect(unknown.ok && unknown.value.status).toBe('PENDING_APPROVAL');
    });

    it('waits for an admin above the Market high-discount threshold', async () => {
      const high = await make(CreateOwnPromotion).execute(
        seller(),
        sale({ reward: { kind: 'PERCENT', bps: rules.priorApprovalDiscountBps + 100 } }),
      );
      expect(high.ok && high.value.status).toBe('PENDING_APPROVAL');
      expect([...reviewQueue.entries.values()][0]?.reason).toBe('HIGH_DISCOUNT');
    });

    it('refuses what a seller may not do: over the maximum, test mode, platform money, a special campaign', async () => {
      const over = await make(CreateOwnPromotion).execute(
        seller(),
        sale({ reward: { kind: 'PERCENT', bps: rules.sellerMaxDiscountBps + 1 } }),
      );
      expect(over).toMatchObject({
        ok: false,
        error: { fields: [{ path: 'reward.bps', code: 'exceeds-seller-maximum' }] },
      });
      for (const extra of [
        { testMode: true },
        { funding: 'PLATFORM', budgetMinor: '1000' },
        { specialCampaign: true },
        { type: 'FREE_SHIPPING', minSpendMinor: '1000' },
      ]) {
        const result = await make(CreateOwnPromotion).execute(seller(), sale(extra));
        expect(result).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      }
      expect(promotions.records.size).toBe(0);
    });

    it('is refused in an acting-as session and for a non-seller', async () => {
      expect(await createPromotion(deps, actingAs(seller()), sale(), 'seller')).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(await make(CreateOwnPromotion).execute(admin(), sale())).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
    });

    it('lets a seller see and change its own promotions only', async () => {
      const mine = await make(CreateOwnPromotion).execute(seller(), sale());
      if (!mine.ok) throw new Error('create failed');
      const theirs = seller(SELLER_2, SELLER_2_ACCOUNT);
      const input = { promotionId: mine.value.id };
      expect(await make(PauseOwnPromotion).execute(theirs, input)).toEqual({
        ok: false,
        error: { code: 'promotions.not-found' },
      });
      expect(
        await make(EditOwnPromotion).execute(theirs, { ...sale(), promotionId: mine.value.id }),
      ).toEqual({ ok: false, error: { code: 'promotions.not-found' } });
      const listed = await make(ListOwnPromotions).execute(theirs, {});
      expect(listed.ok && listed.value).toEqual([]);
      const own = await make(ListOwnPromotions).execute(seller(), {});
      expect(own.ok && own.value.map((p) => p.id)).toEqual([mine.value.id]);
    });

    it('re-opens the review when a seller edits, and cannot lift an admin pause', async () => {
      const mine = await make(CreateOwnPromotion).execute(seller(), sale());
      if (!mine.ok) throw new Error('create failed');
      const edited = await make(EditOwnPromotion).execute(seller(), {
        ...sale({ name: 'Changed' }),
        promotionId: mine.value.id,
      });
      expect(edited.ok && edited.value.status).toBe('ACTIVE');
      expect([...reviewQueue.entries.values()].map((e) => e.reason)).toEqual(['POST_REVIEW']);

      await make(PausePromotion).execute(admin(), { promotionId: mine.value.id });
      expect(
        await make(ResumeOwnPromotion).execute(seller(), { promotionId: mine.value.id }),
      ).toEqual({ ok: false, error: { code: 'promotions.invalid-state' } });
      await make(ResumePromotion).execute(admin(), { promotionId: mine.value.id });
      await make(PauseOwnPromotion).execute(seller(), { promotionId: mine.value.id });
      const resumed = await make(ResumeOwnPromotion).execute(seller(), {
        promotionId: mine.value.id,
      });
      expect(resumed.ok && resumed.value.status).toBe('ACTIVE');
    });
  });

  describe('the review queue', () => {
    beforeEach(switchOn);

    it('approves a pending promotion once, then refuses a second decision', async () => {
      const pending = await make(CreateOwnPromotion).execute(
        seller(SELLER_2, SELLER_2_ACCOUNT),
        sale(),
      );
      if (!pending.ok) throw new Error('create failed');
      const queue = await make(ListPromotionReviews).execute(admin(), {});
      expect(queue.ok && queue.value).toHaveLength(1);
      if (!queue.ok) return;
      const reviewId = queue.value[0]!.review.id;

      expect(
        await decideReview(deps, actingAs(admin()), {
          reviewId,
          decision: 'APPROVE',
          promotionVersion: queue.value[0]!.promotion.updatedAt.toString(),
        }),
      ).toEqual({ ok: false, error: { code: 'access.denied' } });
      const approved = await make(DecidePromotionReview).execute(admin(), {
        reviewId,
        decision: 'APPROVE',
        promotionVersion: queue.value[0]!.promotion.updatedAt.toString(),
      });
      expect(approved.ok).toBe(true);
      expect(promotions.records.get(pending.value.id)?.status).toBe('ACTIVE');
      expect(audit.entries.at(-1)?.action).toBe('promotions.review.decided');
      expect(
        await make(DecidePromotionReview).execute(admin(), {
          reviewId,
          decision: 'REJECT',
          promotionVersion: queue.value[0]!.promotion.updatedAt.toString(),
        }),
      ).toEqual({ ok: false, error: { code: 'promotions.invalid-state' } });
    });

    it('rejecting ends the promotion', async () => {
      const pending = await make(CreateOwnPromotion).execute(
        seller(SELLER_2, SELLER_2_ACCOUNT),
        sale(),
      );
      if (!pending.ok) throw new Error('create failed');
      const reviewId = [...reviewQueue.entries.keys()][0]!;
      const rejected = await make(DecidePromotionReview).execute(admin(), {
        reviewId,
        decision: 'REJECT',
        promotionVersion: promotions.records.get(pending.value.id)!.updatedAt.toString(),
      });
      expect(rejected.ok).toBe(true);
      expect(promotions.records.get(pending.value.id)?.status).toBe('REJECTED');
    });
  });

  describe('co-funded campaigns', () => {
    beforeEach(switchOn);

    const campaign = (extra: Record<string, unknown> = {}) =>
      platformCart({
        type: 'CO_FUNDED_CAMPAIGN',
        funding: 'CO_FUNDED',
        platformSplitBps: 5000,
        name: 'Big sale',
        ...extra,
      });

    it('a seller opts in and out; a campaign aimed at other sellers does not exist for it', async () => {
      const created = await make(CreatePromotion).execute(admin(), campaign());
      if (!created.ok) throw new Error('create failed');
      const input = { promotionId: created.value.id, optIn: true };
      const opted = await make(SetCoFundingOptIn).execute(seller(), input);
      expect(opted).toEqual({ ok: true, value: { promotionId: created.value.id, optedIn: true } });
      expect((await optIns.liveSellers(market, [created.value.id])).get(created.value.id)).toEqual([
        SELLER,
      ]);
      await make(SetCoFundingOptIn).execute(seller(), { ...input, optIn: false });
      expect((await optIns.liveSellers(market, [created.value.id])).size).toBe(0);

      const aimed = await make(CreatePromotion).execute(
        admin(),
        campaign({ name: 'Aimed', sellerIds: [SELLER_2] }),
      );
      if (!aimed.ok) throw new Error('create failed');
      expect(
        await make(SetCoFundingOptIn).execute(seller(), {
          promotionId: aimed.value.id,
          optIn: true,
        }),
      ).toEqual({ ok: false, error: { code: 'promotions.not-found' } });
    });

    it('refuses an opt-in from an acting-as seller', async () => {
      const created = await make(CreatePromotion).execute(admin(), campaign());
      if (!created.ok) throw new Error('create failed');
      expect(
        await setOptIn(deps, actingAs(seller()), {
          promotionId: created.value.id,
          optIn: true,
        }),
      ).toEqual({ ok: false, error: { code: 'access.denied' } });
    });
  });

  describe('quotes', () => {
    beforeEach(switchOn);

    const request = (extra: Record<string, unknown> = {}) => ({
      lines: [
        {
          id: 'l1',
          sellerId: SELLER,
          productId: product(1),
          unitPrice: money(10000n, currency),
          quantity: 2,
        },
      ],
      shipping: [],
      code: null,
      isFirstOrder: false,
      testMode: false,
      orderCommission: money(5000n, currency),
      ...extra,
    });

    it('applies a live seller sale and nothing else on a cart without a promotion', async () => {
      const facade = new PromotionsFacadeImplementation(make(QuoteDiscounts), make(CheckWasPrice));
      const before = await facade.quote(system, request());
      expect(before.ok && before.value.applied).toEqual([]);

      await make(CreateOwnPromotion).execute(seller(), sale());
      const quoted = await facade.quote(system, request());
      expect(quoted.ok).toBe(true);
      if (!quoted.ok) return;
      expect(quoted.value.enabled).toBe(true);
      expect(quoted.value.applied).toHaveLength(1);
      expect(quoted.value.lines[0]?.discount).toBe(2000n);
    });

    it('does not apply a paused promotion, or one that has not started yet', async () => {
      const facade = new PromotionsFacadeImplementation(make(QuoteDiscounts), make(CheckWasPrice));
      const created = await make(CreateOwnPromotion).execute(seller(), sale());
      if (!created.ok) throw new Error('create failed');
      await make(PauseOwnPromotion).execute(seller(), { promotionId: created.value.id });
      const paused = await facade.quote(system, request());
      expect(paused.ok && paused.value.applied).toEqual([]);
      await make(ResumeOwnPromotion).execute(seller(), { promotionId: created.value.id });
      const live = await facade.quote(system, request());
      expect(live.ok && live.value.applied).toHaveLength(1);
    });

    it('starts a promotion at its start time and ends it at its end time', async () => {
      const facade = new PromotionsFacadeImplementation(make(QuoteDiscounts), make(CheckWasPrice));
      await make(CreateOwnPromotion).execute(
        seller(),
        sale({
          startsAt: T0.add({ hours: 24 }).toString(),
          endsAt: T0.add({ hours: 48 }).toString(),
        }),
      );
      const early = await facade.quote(system, request());
      expect(early.ok && early.value.applied).toEqual([]);
      clock.advance(Temporal.Duration.from({ hours: 25 }));
      const during = await facade.quote(system, request());
      expect(during.ok && during.value.applied).toHaveLength(1);
      clock.advance(Temporal.Duration.from({ hours: 24 }));
      const after = await facade.quote(system, request());
      expect(after.ok && after.value.applied).toEqual([]);
    });

    it('applies a test-mode promotion to a test order only', async () => {
      const facade = new PromotionsFacadeImplementation(make(QuoteDiscounts), make(CheckWasPrice));
      await make(CreatePromotion).execute(
        admin(),
        platformCart({ testMode: true, name: 'Test only' }),
      );
      const real = await facade.quote(system, request());
      expect(real.ok && real.value.applied).toEqual([]);
      const test = await facade.quote(system, request({ testMode: true }));
      expect(test.ok && test.value.applied).toHaveLength(1);
    });

    it('is a system call: no browser actor may run it', async () => {
      const result = await make(QuoteDiscounts).execute(customer, request());
      expect(result.ok).toBe(false);
    });

    it('previews for an admin, with test mode as the default, and refuses an acting-as admin', async () => {
      await make(CreatePromotion).execute(admin(), platformCart({ testMode: true }));
      const body = {
        lines: [
          {
            id: 'l1',
            sellerId: SELLER,
            productId: product(1),
            unitPriceMinor: '10000',
            quantity: 2,
          },
        ],
        orderCommissionMinor: '5000',
      };
      const preview = await make(PreviewQuote).execute(admin(), body);
      expect(preview.ok && preview.value.applied).toHaveLength(1);
      expect(canPreview(actingAs(admin()))).toBe(false);
      expect(canPreview(admin())).toBe(true);
      expect(await make(PreviewQuote).execute(admin(), { lines: [] })).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
    });
  });

  describe('first-order and free-shipping settings', () => {
    beforeEach(switchOn);

    it('reads the Market defaults, then the edited setting, audited', async () => {
      const first = await make(ViewFirstOrderSettings).execute(admin(), {});
      expect(first.ok && first.value.source).toBe(rules.firstOrder ? 'config' : 'none');

      const saved = await make(SetFirstOrderSettings).execute(admin(), {
        enabled: true,
        kind: 'PERCENT',
        percentBps: 500,
        capMinor: '2000',
        minSpendMinor: '3000',
        monthlyBudgetMinor: '50000',
      });
      expect(saved.ok).toBe(true);
      const again = await make(ViewFirstOrderSettings).execute(admin(), {});
      expect(again.ok && again.value.source).toBe('stored');
      expect(audit.entries.at(-1)?.action).toBe('promotions.first-order-settings.changed');
      expect(
        await make(SetFirstOrderSettings).execute(admin(), {
          enabled: true,
          kind: 'PERCENT',
          minSpendMinor: '0',
          monthlyBudgetMinor: '1',
        }),
      ).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    });

    it('sets and clears a zone threshold', async () => {
      const set = await make(SetFreeShippingThreshold).execute(admin(), {
        zoneCode: 'remote',
        thresholdMinor: '12000',
      });
      expect(set).toMatchObject({ ok: true });
      expect(thresholds.rows.get('remote')?.thresholdMinor).toBe(12000n);
      await make(SetFreeShippingThreshold).execute(admin(), {
        zoneCode: 'remote',
        thresholdMinor: null,
      });
      expect(thresholds.rows.size).toBe(0);
    });
  });

  describe('the was-price check', () => {
    it('is fail-closed while no price history exists', async () => {
      await switchOn();
      deps = { ...deps, priceHistory: { daysSoldAtPrice: () => Promise.resolve(null) } };
      const result = await make(CheckWasPrice).execute(anonymous, {
        ...unit(1),
        price: { amountMinor: 10000n, currency },
      });
      expect(result).toEqual({ ok: true, value: { eligible: false } });
    });

    it('answers yes only on enough days at that price', async () => {
      await switchOn();
      const ask = () =>
        make(CheckWasPrice).execute(anonymous, {
          ...unit(1),
          price: { amountMinor: 10000n, currency },
        });
      history.days = rules.wasPrice.minDaysAtPrice - 1;
      expect(await ask()).toEqual({ ok: true, value: { eligible: false } });
      history.days = rules.wasPrice.minDaysAtPrice;
      expect(await ask()).toEqual({ ok: true, value: { eligible: true } });
    });
  });
  describe('after the security review', () => {
    beforeEach(switchOn);

    const campaign = (extra: Record<string, unknown> = {}) =>
      platformCart({
        type: 'CO_FUNDED_CAMPAIGN',
        funding: 'CO_FUNDED',
        platformSplitBps: 5000,
        name: 'Big sale',
        ...extra,
      });
    const quoteRequest = (extra: Record<string, unknown> = {}) => ({
      lines: [
        {
          id: 'l1',
          sellerId: SELLER,
          productId: product(1),
          unitPrice: money(10000n, currency),
          quantity: 1,
        },
      ],
      shipping: [],
      code: null,
      isFirstOrder: false,
      testMode: false,
      orderCommission: money(5000n, currency),
      ...extra,
    });
    const liveOptIns = async (promotionId: Id<'Promotion'>) =>
      (await optIns.liveSellers(market, [promotionId])).get(promotionId) ?? [];

    describe('a co-funded campaign changed by an admin (M1)', () => {
      const optedIn = async () => {
        const created = await make(CreatePromotion).execute(admin(), campaign());
        if (!created.ok) throw new Error('create failed');
        for (const [who, account] of [
          [SELLER, SELLER_ACCOUNT],
          [SELLER_2, SELLER_2_ACCOUNT],
        ] as const) {
          const opted = await make(SetCoFundingOptIn).execute(seller(who, account), {
            promotionId: created.value.id,
            optIn: true,
          });
          expect(opted.ok).toBe(true);
        }
        audit.entries.length = 0;
        return created.value.id;
      };
      const edit = (promotionId: Id<'Promotion'>, extra: Record<string, unknown>) =>
        make(EditPromotion).execute(admin(), { ...campaign(extra), promotionId });

      it('keeps the opt-ins when only the name or the schedule changes', async () => {
        const promotionId = await optedIn();
        expect((await edit(promotionId, { name: 'Renamed', combinable: false })).ok).toBe(true);
        expect(await liveOptIns(promotionId)).toHaveLength(2);
        expect(audit.entries.map((e) => e.action)).toEqual(['promotions.promotion.edited']);
      });

      it.each([
        ['reward', { reward: { kind: 'PERCENT', bps: 700 } }],
        ['platform split', { platformSplitBps: 6000 }],
        ['products', { productIds: [product(7)] }],
        ['sellers', { sellerIds: [SELLER, SELLER_2] }],
      ])(
        'withdraws every opt-in, audited, when the %s change; the sellers opt in again',
        async (_name, change) => {
          const promotionId = await optedIn();
          const edited = await edit(promotionId, change);
          expect(edited.ok).toBe(true);
          expect(await liveOptIns(promotionId)).toEqual([]);
          const withdrawals = audit.entries.filter(
            (e) => e.action === 'promotions.co-funding.changed',
          );
          expect(withdrawals).toHaveLength(2);
          expect(withdrawals.map((e) => (e.after as { sellerId: string }).sellerId).sort()).toEqual(
            [SELLER, SELLER_2].sort(),
          );
          for (const entry of withdrawals) {
            expect(entry.before).toEqual({ optedIn: true });
            expect(entry.after).toMatchObject({ optedIn: false });
          }
          const again = await make(SetCoFundingOptIn).execute(seller(), {
            promotionId,
            optIn: true,
          });
          expect(again).toEqual({ ok: true, value: { promotionId, optedIn: true } });
          expect(await liveOptIns(promotionId)).toEqual([SELLER]);
        },
      );

      it.each([
        [
          'a later end',
          { endsAt: T0.add({ hours: 24 * 30 }).toString() },
          { endsAt: T0.add({ hours: 24 * 10 }).toString() },
        ],
        [
          'an earlier start',
          { startsAt: T0.subtract({ hours: 48 }).toString() },
          { startsAt: T0.subtract({ hours: 24 }).toString() },
        ],
        ['no end at all', { endsAt: undefined }, { endsAt: T0.add({ hours: 24 * 10 }).toString() }],
        ['a higher cap', { capMinor: '3000' }, { capMinor: '2000' }],
        ['no cap', { capMinor: undefined }, { capMinor: '2000' }],
        ['a higher per-order limit', { maxPerOrderMinor: '9000' }, { maxPerOrderMinor: '5000' }],
        ['a lower minimum spend', { minSpendMinor: '1000' }, { minSpendMinor: '2000' }],
        ['no minimum spend', { minSpendMinor: undefined }, { minSpendMinor: '2000' }],
        ['combinable', { combinable: true }, { combinable: false }],
      ])(
        'withdraws every opt-in when an edit widens the exposure: %s',
        async (_name, wider, base) => {
          const created = await make(CreatePromotion).execute(admin(), campaign(base));
          if (!created.ok) throw new Error('create failed');
          const promotionId = created.value.id;
          await make(SetCoFundingOptIn).execute(seller(), { promotionId, optIn: true });
          audit.entries.length = 0;
          expect((await edit(promotionId, { ...base, ...wider })).ok).toBe(true);
          expect(await liveOptIns(promotionId)).toEqual([]);
          expect(
            audit.entries.filter((e) => e.action === 'promotions.co-funding.changed'),
          ).toHaveLength(1);
        },
      );

      it.each([
        [
          'an earlier end',
          { endsAt: T0.add({ hours: 24 * 5 }).toString() },
          { endsAt: T0.add({ hours: 24 * 10 }).toString() },
        ],
        [
          'a later start',
          { startsAt: T0.subtract({ hours: 12 }).toString() },
          { startsAt: T0.subtract({ hours: 24 }).toString() },
        ],
        ['a lower cap', { capMinor: '1000' }, { capMinor: '2000' }],
        ['a lower per-order limit', { maxPerOrderMinor: '4000' }, { maxPerOrderMinor: '5000' }],
        ['a higher minimum spend', { minSpendMinor: '3000' }, { minSpendMinor: '2000' }],
        ['not combinable', { combinable: false }, { combinable: true }],
        ['a lower budget', { budgetMinor: '50000' }, { budgetMinor: '100000' }],
      ])(
        'keeps the opt-ins when an edit narrows the exposure: %s',
        async (_name, narrower, base) => {
          const created = await make(CreatePromotion).execute(admin(), campaign(base));
          if (!created.ok) throw new Error('create failed');
          const promotionId = created.value.id;
          await make(SetCoFundingOptIn).execute(seller(), { promotionId, optIn: true });
          expect((await edit(promotionId, { ...base, ...narrower })).ok).toBe(true);
          expect(await liveOptIns(promotionId)).toEqual([SELLER]);
        },
      );

      it('withdraws every opt-in when the budget of a co-funded campaign is raised, not lowered', async () => {
        const promotionId = await optedIn();
        const lowered = await make(SetPromotionBudget).execute(admin(), {
          promotionId,
          budgetMinor: '50000',
        });
        expect(lowered.ok).toBe(true);
        expect(await liveOptIns(promotionId)).toHaveLength(2);
        audit.entries.length = 0;
        const raised = await make(SetPromotionBudget).execute(admin(), {
          promotionId,
          budgetMinor: '90000',
        });
        expect(raised.ok).toBe(true);
        expect(await liveOptIns(promotionId)).toEqual([]);
        const withdrawals = audit.entries.filter(
          (e) => e.action === 'promotions.co-funding.changed',
        );
        expect(withdrawals).toHaveLength(2);
        expect(withdrawals.every((e) => (e.after as { optedIn: boolean }).optedIn === false)).toBe(
          true,
        );
      });

      it('does not touch opt-ins when the budget of a platform promotion changes', async () => {
        const created = await make(CreatePromotion).execute(admin(), platformCart());
        if (!created.ok) throw new Error('create failed');
        audit.entries.length = 0;
        await make(SetPromotionBudget).execute(admin(), {
          promotionId: created.value.id,
          budgetMinor: '90000',
        });
        expect(audit.entries.map((e) => e.action)).toEqual(['promotions.promotion.budget-changed']);
      });

      it('leaves a withdrawn opt-in alone and a refused edit changes nothing', async () => {
        const promotionId = await optedIn();
        await make(SetCoFundingOptIn).execute(seller(SELLER_2, SELLER_2_ACCOUNT), {
          promotionId,
          optIn: false,
        });
        audit.entries.length = 0;
        expect((await edit(promotionId, { platformSplitBps: 6000 })).ok).toBe(true);
        expect(
          audit.entries.filter((e) => e.action === 'promotions.co-funding.changed'),
        ).toHaveLength(1);
        // An edit refused for its terms withdraws nobody.
        const refused = await edit(promotionId, {
          platformSplitBps: 1000,
          reward: { kind: 'PERCENT', bps: 10000 },
        });
        expect(refused).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      });

      it('refuses a campaign whose seller share is over the seller maximum', async () => {
        const over = await make(CreatePromotion).execute(
          admin(),
          campaign({ platformSplitBps: 1000, reward: { kind: 'PERCENT', bps: 10000 } }),
        );
        expect(over).toMatchObject({
          ok: false,
          error: {
            code: 'validation.failed',
            fields: [{ path: 'reward.bps', code: 'exceeds-seller-maximum' }],
          },
        });
        const within = await make(CreatePromotion).execute(
          admin(),
          campaign({
            platformSplitBps: 10000 - rules.sellerMaxDiscountBps,
            reward: { kind: 'PERCENT', bps: 10000 },
          }),
        );
        expect(within.ok).toBe(true);
      });
    });

    describe('the review queue after a seller edit (M2)', () => {
      const pendingReview = async () => {
        const mine = await make(CreateOwnPromotion).execute(seller(), sale());
        if (!mine.ok) throw new Error('create failed');
        return mine.value.id;
      };

      it('updates the one open entry instead of dropping the new reason', async () => {
        const promotionId = await pendingReview();
        const [first] = [...reviewQueue.entries.values()];
        expect(first).toMatchObject({ reason: 'POST_REVIEW', status: 'OPEN' });

        clock.advance(Temporal.Duration.from({ hours: 3 }));
        const highBps = rules.priorApprovalDiscountBps + 100;
        const edited = await make(EditOwnPromotion).execute(seller(), {
          ...sale({ reward: { kind: 'PERCENT', bps: highBps } }),
          promotionId,
        });
        expect(edited.ok && edited.value.status).toBe('PENDING_APPROVAL');

        const entries = [...reviewQueue.entries.values()];
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          id: first!.id,
          reason: 'HIGH_DISCOUNT',
          status: 'OPEN',
          openedAt: clock.now(),
        });
      });

      it('refuses a decision on a promotion that changed after the admin looked', async () => {
        const promotionId = await pendingReview();
        const queue = await make(ListPromotionReviews).execute(admin(), {});
        if (!queue.ok) throw new Error('list failed');
        const item = queue.value[0]!;
        const seen = item.promotion.updatedAt.toString();

        clock.advance(Temporal.Duration.from({ hours: 1 }));
        await make(EditOwnPromotion).execute(seller(), {
          ...sale({ name: 'Changed after the admin looked' }),
          promotionId,
        });

        const stale = await make(DecidePromotionReview).execute(admin(), {
          reviewId: item.review.id,
          decision: 'APPROVE',
          promotionVersion: seen,
        });
        expect(stale).toEqual({ ok: false, error: { code: 'promotions.invalid-state' } });
        expect(reviewQueue.entries.get(item.review.id)?.status).toBe('OPEN');

        const refreshed = await make(ListPromotionReviews).execute(admin(), {});
        if (!refreshed.ok) throw new Error('list failed');
        const fresh = refreshed.value[0]!;
        expect(fresh.promotion.updatedAt.toString()).not.toBe(seen);
        const ok = await make(DecidePromotionReview).execute(admin(), {
          reviewId: fresh.review.id,
          decision: 'APPROVE',
          promotionVersion: fresh.promotion.updatedAt.toString(),
        });
        expect(ok.ok).toBe(true);
      });

      it('wants the promotion version in a decision', async () => {
        await pendingReview();
        const reviewId = [...reviewQueue.entries.keys()][0]!;
        for (const promotionVersion of [undefined, 'yesterday', 42]) {
          expect(
            await make(DecidePromotionReview).execute(admin(), {
              reviewId,
              decision: 'APPROVE',
              promotionVersion,
            }),
          ).toMatchObject({
            ok: false,
            error: { code: 'validation.failed', fields: [{ path: 'promotionVersion' }] },
          });
        }
        expect(reviewQueue.entries.get(reviewId)?.status).toBe('OPEN');
      });
    });

    describe('the currency of a quote (L1)', () => {
      const foreign = (extra: Record<string, unknown> = {}) =>
        quoteRequest({
          lines: [
            {
              id: 'l1',
              sellerId: SELLER,
              productId: product(1),
              unitPrice: money(10000n, 'EUR'),
              quantity: 1,
            },
          ],
          ...extra,
        });
      const facade = () =>
        new PromotionsFacadeImplementation(make(QuoteDiscounts), make(CheckWasPrice));
      const mismatch = {
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'currency', code: 'mismatch' }] },
      };

      it('is refused with the switch on', async () => {
        expect(await facade().quote(system, foreign())).toMatchObject(mismatch);
      });

      it('is refused with the switch off too, before the no-discount answer', async () => {
        await make(SetPromotionsStatus).execute(admin(), { status: 'off' });
        expect(await facade().quote(system, foreign())).toMatchObject(mismatch);
        expect(
          await facade().quote(system, quoteRequest({ orderCommission: money(5000n, 'EUR') })),
        ).toMatchObject(mismatch);
        const wrongShipping = quoteRequest({
          shipping: [{ id: 's1', sellerId: null, zoneCode: 'Z1', amount: money(900n, 'EUR') }],
        });
        expect(await facade().quote(system, wrongShipping)).toMatchObject(mismatch);
        const right = await facade().quote(system, quoteRequest());
        expect(right.ok && right.value.enabled).toBe(false);
      });
    });

    describe('the free-shipping threshold (L3)', () => {
      const marketDefault = policy.settings(market)!.freeShippingThresholdMinor;
      const set = (thresholdMinor: bigint | null) =>
        make(SetFreeShippingThreshold).execute(admin(), {
          zoneCode: 'remote',
          thresholdMinor: thresholdMinor === null ? null : String(thresholdMinor),
        });

      it('needs a fresh code to go below the Market default', async () => {
        expect(await set(marketDefault - 1n)).toMatchObject({
          ok: false,
          error: {
            code: 'second-factor.required',
            actionKey: 'promotions.platform-funding.approve',
          },
        });
        expect(thresholds.rows.size).toBe(0);
        stepUp.fresh = true;
        expect((await set(marketDefault - 1n)).ok).toBe(true);
        expect(stepUp.spent).toEqual(['promotions.platform-funding.approve']);
        expect(thresholds.rows.get('remote')?.thresholdMinor).toBe(marketDefault - 1n);
        expect(Object.keys(audit.entries.at(-1)?.after ?? {})).toContain('stepUpSessionId');
      });

      it('needs no code at or above the default, to clear a zone, or to repeat the stored value', async () => {
        expect((await set(marketDefault)).ok).toBe(true);
        expect((await set(marketDefault + 1000n)).ok).toBe(true);
        expect((await set(null)).ok).toBe(true);
        stepUp.fresh = true;
        expect((await set(marketDefault - 1n)).ok).toBe(true);
        expect((await set(marketDefault - 1n)).ok).toBe(true);
        expect(stepUp.spent).toHaveLength(1);
      });

      it('refuses a threshold of zero', async () => {
        expect(await set(0n)).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      });
    });

    describe('re-enabling the first-order discount (L4)', () => {
      const budget = String(BigInt(rules.platformBudgetStepUpMinor) + 1n);
      const save = (enabled: boolean, monthlyBudgetMinor = budget) =>
        make(SetFirstOrderSettings).execute(admin(), {
          enabled,
          kind: 'PERCENT',
          percentBps: 500,
          minSpendMinor: '3000',
          monthlyBudgetMinor,
        });

      it('needs a fresh code to switch it back on with a budget above the step-up amount', async () => {
        stepUp.fresh = true;
        expect((await save(false)).ok).toBe(true);
        expect(await save(true)).toMatchObject({
          ok: false,
          error: { code: 'second-factor.required' },
        });
        expect(firstOrder.row?.enabled).toBe(false);
        stepUp.fresh = true;
        expect((await save(true)).ok).toBe(true);
        expect(firstOrder.row?.enabled).toBe(true);
        // Already on with the same budget, a change of nothing else needs no code.
        expect((await save(true)).ok).toBe(true);
        // Switching it off never does.
        expect((await save(false)).ok).toBe(true);
      });

      it('needs no code to switch it on with a budget at or below the step-up amount', async () => {
        const small = String(BigInt(rules.platformBudgetStepUpMinor));
        expect((await save(false, small)).ok).toBe(true);
        expect((await save(true, small)).ok).toBe(true);
      });
    });

    describe('promotions per seller (L5)', () => {
      const cap = rules.maxActivePromotionsPerSeller;
      const fill = async (count: number, extra: Record<string, unknown> = {}) => {
        const ids: Id<'Promotion'>[] = [];
        for (let i = 0; i < count; i++) {
          const made = await make(CreateOwnPromotion).execute(
            seller(),
            sale({ name: `s${i}`, ...extra }),
          );
          if (!made.ok) throw new Error(`create ${i} failed: ${JSON.stringify(made.error)}`);
          ids.push(made.value.id);
        }
        return ids;
      };

      it('refuses the promotion past the Market maximum, for that seller only', async () => {
        await fill(cap);
        expect(
          await make(CreateOwnPromotion).execute(seller(), sale({ name: 'one more' })),
        ).toEqual({
          ok: false,
          error: { code: 'promotions.too-many-active' },
        });
        expect(promotions.records.size).toBe(cap);
        const other = await make(CreateOwnPromotion).execute(
          seller(SELLER_2, SELLER_2_ACCOUNT),
          sale({ name: 'other seller' }),
        );
        expect(other.ok).toBe(true);
      });

      it('does not count a paused promotion, and does not let it come back past the maximum', async () => {
        const ids = await fill(cap);
        await make(PauseOwnPromotion).execute(seller(), { promotionId: ids[0] });
        expect((await make(CreateOwnPromotion).execute(seller(), sale({ name: 'x' }))).ok).toBe(
          true,
        );
        // The paused one cannot come back while the seller is at the maximum.
        expect(await make(ResumeOwnPromotion).execute(seller(), { promotionId: ids[0] })).toEqual({
          ok: false,
          error: { code: 'promotions.too-many-active' },
        });
        expect(promotions.records.get(ids[0]!)?.status).toBe('PAUSED');
      });

      it('does not let an edit bring an ended promotion back past the maximum', async () => {
        const startsAt = T0.subtract({ hours: 72 }).toString();
        const ended = await fill(cap, { startsAt, endsAt: T0.subtract({ hours: 24 }).toString() });
        // All ended: the seller is not at the maximum.
        const live = await make(CreateOwnPromotion).execute(seller(), sale({ name: 'live' }));
        expect(live.ok).toBe(true);
        const stillRoom = await fill(cap - 1, { name: 'filler' });
        expect(stillRoom).toHaveLength(cap - 1);
        const revived = await make(EditOwnPromotion).execute(seller(), {
          ...sale({ startsAt, endsAt: null }),
          promotionId: ended[0],
        });
        expect(revived).toEqual({ ok: false, error: { code: 'promotions.too-many-active' } });
      });

      it('asks the repository for the cart sellers and products only', async () => {
        await make(CreateOwnPromotion).execute(seller(), sale());
        const request = quoteRequest({
          lines: [
            {
              id: 'a',
              sellerId: SELLER_2,
              productId: product(9),
              unitPrice: money(500n, currency),
              quantity: 1,
            },
            {
              id: 'b',
              sellerId: SELLER,
              productId: product(1),
              unitPrice: money(500n, currency),
              quantity: 2,
            },
            {
              id: 'c',
              sellerId: SELLER,
              productId: product(1),
              unitPrice: money(500n, currency),
              quantity: 1,
            },
          ],
        });
        const quoted = await new PromotionsFacadeImplementation(
          make(QuoteDiscounts),
          make(CheckWasPrice),
        ).quote(system, request);
        expect(quoted.ok).toBe(true);
        expect(promotions.lastScope).toEqual({
          sellerIds: [SELLER, SELLER_2].sort(),
          productIds: [product(1), product(9)].sort(),
        });
      });
    });

    describe('a row lock that cannot be taken (N2)', () => {
      it('answers invalid-state, never an error, on every write that locks', async () => {
        const created = await make(CreatePromotion).execute(admin(), platformCart());
        if (!created.ok) throw new Error('create failed');
        const promotionId = created.value.id;
        const mine = await make(CreateOwnPromotion).execute(seller(), sale());
        if (!mine.ok) throw new Error('create failed');
        const reviewId = [...reviewQueue.entries.keys()][0]!;
        const camp = await make(CreatePromotion).execute(
          admin(),
          platformCart({
            type: 'CO_FUNDED_CAMPAIGN',
            funding: 'CO_FUNDED',
            platformSplitBps: 5000,
            name: 'Locked',
          }),
        );
        if (!camp.ok) throw new Error('create failed');

        promotions.contended = true;
        firstOrder.contended = true;
        const refused = { ok: false, error: { code: 'promotions.invalid-state' } };
        expect(
          await make(EditPromotion).execute(admin(), { ...platformCart(), promotionId }),
        ).toEqual(refused);
        expect(
          await make(SetPromotionBudget).execute(admin(), { promotionId, budgetMinor: '5000' }),
        ).toEqual(refused);
        expect(await make(PausePromotion).execute(admin(), { promotionId })).toEqual(refused);
        expect(await make(ResumePromotion).execute(admin(), { promotionId })).toEqual(refused);
        expect(
          await make(DecidePromotionReview).execute(admin(), {
            reviewId,
            decision: 'APPROVE',
            promotionVersion: mine.value.updatedAt.toString(),
          }),
        ).toEqual(refused);
        expect(
          await make(SetCoFundingOptIn).execute(seller(), {
            promotionId: camp.value.id,
            optIn: true,
          }),
        ).toEqual(refused);
        expect(
          await make(SetFirstOrderSettings).execute(admin(), {
            enabled: true,
            kind: 'PERCENT',
            percentBps: 500,
            minSpendMinor: '3000',
            monthlyBudgetMinor: '1000',
          }),
        ).toEqual(refused);
        // Nothing was written by any of them.
        expect(promotions.records.get(promotionId)?.budgetMinor).toBe(100000n);
        expect(firstOrder.row).toBeNull();

        promotions.contended = false;
        expect(
          (await make(SetPromotionBudget).execute(admin(), { promotionId, budgetMinor: '5000' }))
            .ok,
        ).toBe(true);
      });
    });

    describe('reads that decide a write take the row lock (M)', () => {
      it('locks the promotion before an edit, a budget change, a pause and a decision', async () => {
        const created = await make(CreatePromotion).execute(admin(), platformCart());
        if (!created.ok) throw new Error('create failed');
        const promotionId = created.value.id;
        promotions.locked.length = 0;
        await make(EditPromotion).execute(admin(), { ...platformCart({ name: 'n' }), promotionId });
        await make(SetPromotionBudget).execute(admin(), { promotionId, budgetMinor: '5000' });
        await make(PausePromotion).execute(admin(), { promotionId });
        await make(ResumePromotion).execute(admin(), { promotionId });
        expect(promotions.locked).toEqual([promotionId, promotionId, promotionId, promotionId]);

        const mine = await make(CreateOwnPromotion).execute(seller(), sale());
        if (!mine.ok) throw new Error('create failed');
        promotions.locked.length = 0;
        const reviewId = [...reviewQueue.entries.keys()][0]!;
        await make(DecidePromotionReview).execute(admin(), {
          reviewId,
          decision: 'APPROVE',
          promotionVersion: mine.value.updatedAt.toString(),
        });
        expect(promotions.locked).toEqual([mine.value.id]);
      });
    });
  });
});
