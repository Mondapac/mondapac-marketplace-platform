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
import {
  TEST_CODE_PEPPER,
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
} from '../../../../test/support/test-config';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { AccessDecision } from '../../../platform/authz';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { PROMOTIONS_AUDIT_ACTIONS } from '../domain/audit';
import { ConfigPromotionsPolicy } from '../infrastructure/config-promotions-policy';
import { CryptoBatchCodeCrypto } from '../infrastructure/crypto-batch-code-crypto';
import { PromotionsFacadeImplementation } from '../presentation/promotions.facade';
import type { PromotionsDependencies } from './promotions-dependencies';
import { CheckWasPrice } from './use-cases/check-was-price.use-case';
import { CreateOwnPromotion } from './use-cases/create-own-promotion.use-case';
import { CreatePromotion } from './use-cases/create-promotion.use-case';
import { EditOwnPromotion } from './use-cases/edit-own-promotion.use-case';
import { EditPromotion } from './use-cases/edit-promotion.use-case';
import { GenerateBatchCodes } from './use-cases/generate-batch-codes.use-case';
import { SetFirstOrderSettings } from './use-cases/set-first-order-settings.use-case';
import { PausePromotion } from './use-cases/pause-promotion.use-case';
import { QuoteDiscounts } from './use-cases/quote-discounts.use-case';
import { SetPromotionsStatus } from './use-cases/set-promotions-status.use-case';
import { ViewBatchCodeSummary } from './use-cases/view-batch-code-summary.use-case';

// The phase 2 discount types through the use cases and the quote, in memory, on both Market
// fixtures (AU: step-up at 200 000, platform money in test mode; ZZ: step-up at 300 000, tax
// ruling confirmed, other code length and alphabet): who may make which type, the stored terms,
// the quote of each type, the flash sale's window, zone and unit counter, and batches of
// single-use codes (generation, step-up, audit, hashing, the quote of a used code).

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
const ACTIONS = new Set<string>(PROMOTIONS_AUDIT_ACTIONS.map((a) => a.action));

class RecordingAudit implements AuditWriter {
  readonly entries: AuditEntry[] = [];
  record(_context: CallContext, entry: AuditEntry): Promise<void> {
    if (!ACTIONS.has(entry.action)) throw new Error(`audit: unknown action ${entry.action}`);
    this.entries.push(entry);
    return Promise.resolve();
  }
}

describe.each([['AU'], ['ZZ']] as const)('promotions phase 2 types in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const rules = markets.get(market.marketId).promotions!;
  const batch = rules.batchCodes!;
  const policy = new ConfigPromotionsPolicy(markets);
  const currency = policy.settings(market)!.currency;
  const DAY = { hours: 24 };

  let clock: FixedClock;
  let promotions: MemoryPromotions;
  let batchCodes: MemoryBatchCodes;
  let codeCrypto: FakeBatchCodeCrypto;
  let flashSales: FakeFlashSales;
  let activity: FakeSellerActivity;
  let stepUp: FakeStepUp;
  let audit: RecordingAudit;
  let deps: PromotionsDependencies;
  let gate: ReturnType<typeof createUseCaseGate>;

  const admin = () =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ADMIN,
        sessionId: id<'Session'>(0x62),
        sellerId: null,
      }),
      'promo2-admin-abcdef',
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
      'promo2-seller-abcdef',
    );
  const customer = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'customer',
      accountId: id<'Account'>(0xc1),
      sessionId: id<'Session'>(0x64),
      sellerId: null,
    }),
    'promo2-customer-abcdef',
  );
  const system = testCallContext(market, 'system', 'promo2-system-abcdef');
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
    batchCodes = new MemoryBatchCodes();
    codeCrypto = new FakeBatchCodeCrypto();
    flashSales = new FakeFlashSales();
    activity = new FakeSellerActivity();
    stepUp = new FakeStepUp(() => clock.now());
    audit = new RecordingAudit();
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      promotions,
      optIns: new MemoryOptIns(),
      reviews: new MemoryReviewQueue(),
      settings: new MemoryPromotionsSetting(),
      firstOrder: new MemoryFirstOrder(),
      thresholds: new MemoryThresholds(),
      policy,
      batchCodes,
      codeCrypto,
      flashSales,
      sellerActivity: activity,
      priceHistory: new FakePriceHistory(),
      ...phase3Fakes(),
      stepUp,
      audit,
      ids: new SequenceIdGenerator(clock),
      clock,
    };
    activity.since.set(SELLER, T0.subtract({ hours: 24 * 400 }));
    activity.since.set(SELLER_2, T0.subtract({ hours: 24 * 400 }));
    const on = await make(SetPromotionsStatus).execute(admin(), { status: 'active' });
    expect(on.ok).toBe(true);
  });

  const startsAt = () => T0.subtract(DAY).toString();
  // Platform money in a Market whose tax ruling is open stays in test mode.
  const platform = (extra: Record<string, unknown>) => ({
    funding: 'PLATFORM',
    startsAt: startsAt(),
    budgetMinor: '100000',
    testMode: !rules.gstRulingConfirmed,
    ...extra,
  });
  const tiered = (extra: Record<string, unknown> = {}) =>
    platform({
      type: 'TIERED_CART',
      name: 'Spend more',
      tiers: [
        { thresholdMinor: '5000', reward: { kind: 'FIXED', amountMinor: '500' } },
        { thresholdMinor: '10000', reward: { kind: 'FIXED', amountMinor: '1500' } },
      ],
      ...extra,
    });
  const bxgy = (extra: Record<string, unknown> = {}) => ({
    type: 'BUY_X_GET_Y',
    name: 'Buy 2 get 1',
    funding: 'SELLER',
    startsAt: startsAt(),
    buyQty: 2,
    getQty: 1,
    reward: { kind: 'PERCENT', bps: 10000 },
    productIds: [product(1)],
    ...extra,
  });
  const multi = (extra: Record<string, unknown> = {}) => ({
    type: 'MULTI_BUY',
    name: '3 for 2000',
    funding: 'SELLER',
    startsAt: startsAt(),
    groupQty: 3,
    groupPriceMinor: '2000',
    productIds: [product(1)],
    ...extra,
  });
  const bundle = (extra: Record<string, unknown> = {}) => ({
    type: 'BUNDLE',
    name: 'Breakfast',
    funding: 'SELLER',
    startsAt: startsAt(),
    reward: { kind: 'FIXED', amountMinor: '400' },
    bundleItems: [
      { productId: product(1), quantity: 1 },
      { productId: product(2), quantity: 1 },
    ],
    ...extra,
  });
  const flash = (extra: Record<string, unknown> = {}) => ({
    type: 'FLASH_SALE',
    name: 'Tonight',
    funding: 'SELLER',
    reward: { kind: 'PERCENT', bps: 3000 },
    productIds: [product(1)],
    // 18:00 to 21:00 Brisbane (UTC+10) is 08:00 to 11:00 UTC; the fixed clock is 10:00 UTC.
    flash: {
      unitLimit: 5,
      timeZone: 'Australia/Brisbane',
      startsLocal: '2026-10-25T18:00',
      endsLocal: '2026-10-25T21:00',
    },
    ...extra,
  });
  const batchPromotion = (extra: Record<string, unknown> = {}) =>
    platform({
      type: 'BATCH_CODE',
      name: 'Newsletter',
      reward: { kind: 'FIXED', amountMinor: '500' },
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
    shipping: [],
    code: null as string | null,
    isFirstOrder: false,
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
  const sellerCreate = (body: Record<string, unknown>, who = seller()) =>
    created(make(CreateOwnPromotion).execute(who, body));

  describe('who may make which type', () => {
    it('keeps the seller types to sellers and the platform types to admins', async () => {
      for (const body of [tiered(), batchPromotion()]) {
        const result = await make(CreateOwnPromotion).execute(seller(), body);
        expect(result).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      }
      for (const body of [bxgy(), multi(), bundle()]) {
        const result = await make(CreatePromotion).execute(admin(), body);
        expect(result).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
        const fields = !result.ok && 'fields' in result.error ? result.error.fields : [];
        expect(fields).toContainEqual({ path: 'type', code: 'not-allowed' });
      }
      expect(promotions.records.size).toBe(0);
    });

    it('refuses a customer, a seller on an admin route and an acting-as admin', async () => {
      expect(await make(CreateOwnPromotion).execute(customer, bxgy())).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(await make(CreatePromotion).execute(seller(), tiered())).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(await make(CreatePromotion).execute(actingAs(admin()), tiered())).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(promotions.records.size).toBe(0);
    });

    it('lets a seller edit its own phase 2 promotion only', async () => {
      const own = await sellerCreate(bxgy());
      const edit = { ...bxgy({ name: 'Buy 3 get 1', buyQty: 3 }), promotionId: own.id };
      const other = await make(EditOwnPromotion).execute(seller(SELLER_2, SELLER_2_ACCOUNT), edit);
      expect(other).toEqual({ ok: false, error: { code: 'promotions.not-found' } });
      const mine = await make(EditOwnPromotion).execute(seller(), edit);
      expect(mine.ok).toBe(true);
      expect(promotions.records.get(own.id)).toMatchObject({ buyQty: 3, getQty: 1 });
      // The type never changes.
      const changed = await make(EditOwnPromotion).execute(seller(), {
        ...multi(),
        promotionId: own.id,
      });
      expect(changed).toMatchObject({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'type', code: 'immutable' }] },
      });
    });

    it('answers promotions.disabled for a phase 2 write while the switch is off', async () => {
      await make(SetPromotionsStatus).execute(admin(), { status: 'off' });
      expect(await make(CreateOwnPromotion).execute(seller(), bxgy())).toEqual({
        ok: false,
        error: { code: 'promotions.disabled' },
      });
      expect(
        await make(GenerateBatchCodes).execute(admin(), { promotionId: id(1), count: 1 }),
      ).toEqual({ ok: false, error: { code: 'promotions.disabled' } });
    });
  });

  describe('stored terms', () => {
    it('stores and replaces the tiers and the bundle items', async () => {
      const t = await adminCreate(tiered());
      expect(promotions.records.get(t.id)?.tiers.map((x) => x.thresholdMinor)).toEqual([
        5000n,
        10000n,
      ]);
      const edited = await make(EditPromotion).execute(admin(), {
        ...tiered({
          tiers: [{ thresholdMinor: '7000', reward: { kind: 'FIXED', amountMinor: '700' } }],
        }),
        promotionId: t.id,
      });
      expect(edited.ok).toBe(true);
      expect(promotions.records.get(t.id)?.tiers).toEqual([
        { thresholdMinor: 7000n, reward: { kind: 'FIXED', amount: 700n } },
      ]);
      const b = await sellerCreate(bundle());
      expect(promotions.records.get(b.id)?.productIds).toEqual([product(1), product(2)]);
    });

    it('audits a phase 2 create with its type and never its name', async () => {
      await sellerCreate(multi({ name: 'Secret clearance' }));
      const entry = audit.entries.at(-1)!;
      expect(entry.action).toBe('promotions.promotion.created');
      expect(entry.after).toMatchObject({ type: 'multi-buy' });
      expect(
        JSON.stringify(entry, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v)),
      ).not.toContain('Secret');
    });

    it('sends a seller promotion for approval when the seller is new, like any other', async () => {
      activity.since.set(SELLER, T0.subtract({ hours: 24 }));
      const own = await sellerCreate(bxgy());
      expect(promotions.records.get(own.id)?.status).toBe('PENDING_APPROVAL');
      expect((await quote(request([line(1, 1000n, 3)]))).totals.goodsDiscount).toBe(0n);
    });
  });

  describe('quotes of each type', () => {
    it('tiered cart: the highest tier reached', async () => {
      await adminCreate(tiered());
      expect((await quote(request([line(1, 4000n, 1)]))).totals.goodsDiscount).toBe(0n);
      expect((await quote(request([line(1, 6000n, 1)]))).totals.goodsDiscount).toBe(500n);
      const high = await quote(request([line(1, 6000n, 1), line(2, 4000n, 1, SELLER_2)]));
      expect(high.totals.goodsDiscount).toBe(1500n);
      expect(high.totals.platformShare).toBe(1500n);
      // A real order in a Market with an open tax ruling gets no platform money.
      const real = await quote(request([line(1, 6000n, 1)], { testMode: false }));
      expect(real.totals.goodsDiscount).toBe(rules.gstRulingConfirmed ? 500n : 0n);
    });

    it('buy X get Y, multi-buy and bundle from a seller', async () => {
      await sellerCreate(bxgy());
      expect((await quote(request([line(1, 1000n, 3)]))).totals.goodsDiscount).toBe(
        // The third unit is free, up to the Market's cap of a line.
        1000n,
      );
      await sellerCreate(multi({ productIds: [product(3)] }));
      expect((await quote(request([line(3, 1000n, 3)]))).totals.goodsDiscount).toBe(1000n);
      await sellerCreate(
        bundle({
          bundleItems: [
            { productId: product(4), quantity: 1 },
            { productId: product(5), quantity: 1 },
          ],
        }),
      );
      const out = await quote(request([line(4, 1500n, 1), line(5, 500n, 1)]));
      expect(out.totals.goodsDiscount).toBe(400n);
      expect(out.lines.map((l) => l.discount)).toEqual([300n, 100n]);
      expect(out.totals.sellerShare).toBe(400n);
    });

    it("never applies a seller's offer to another seller's lines", async () => {
      await sellerCreate(bxgy());
      const out = await quote(request([line(1, 1000n, 3, SELLER_2)]));
      expect(out.totals.goodsDiscount).toBe(0n);
    });

    it('holds a multi-buy from an unapproved seller to the lower approval share of a line', async () => {
      const own = await sellerCreate(multi({ groupPriceMinor: '1' }));
      expect(promotions.records.get(own.id)?.priorApproved).toBe(false);
      const out = await quote(request([line(1, 1000n, 3)]));
      // 3 units for 1 would take 99.9 % of the line: held to the lower of the seller maximum and
      // the approval share until an admin has approved the promotion.
      const held = Math.min(rules.sellerMaxDiscountBps, rules.priorApprovalDiscountBps);
      expect(out.totals.goodsDiscount).toBe((3000n * BigInt(held)) / 10000n);
    });

    it('lets the best offer cover a whole line, never a unit by one and the rest by another', async () => {
      const free = await sellerCreate(bxgy());
      const sale = await sellerCreate(flash({ reward: { kind: 'PERCENT', bps: 4000 } }));
      flashSales.sold = new Map([[sale.id, 0]]);
      // 40 % of 3 000 beats the free third unit of 1 000.
      const strong = await quote(request([line(1, 1000n, 3)]));
      expect(strong.lines[0]!.allocations.map((a) => [a.promotionId, a.amount])).toEqual([
        [sale.id, 1200n],
      ]);
      // Lower the sale to 20 %: 600 loses to the free unit.
      await make(EditOwnPromotion).execute(seller(), {
        ...flash({ reward: { kind: 'PERCENT', bps: 2000 } }),
        promotionId: sale.id,
      });
      const weak = await quote(request([line(1, 1000n, 3)]));
      expect(weak.lines[0]!.allocations.map((a) => [a.promotionId, a.amount])).toEqual([
        [free.id, 1000n],
      ]);
    });
  });

  describe('flash sale', () => {
    it('is left out of a real order while no units-sold count can be read, and counts as 0 sold in a test order', async () => {
      const f = await sellerCreate(flash());
      expect(flashSales.sold).toBeNull();
      const real = await quote(request([line(1, 1000n, 3)], { testMode: false }));
      expect(real.applied).toEqual([]);
      const test = await quote(request([line(1, 1000n, 3)], { testMode: true }));
      expect(test.totals.goodsDiscount).toBe(900n);
      // A count that misses this sale is unknown too.
      flashSales.sold = new Map([[id<'Promotion'>(0x9999), 1]]);
      expect((await quote(request([line(1, 1000n, 3)], { testMode: false }))).applied).toEqual([]);
      expect(f.id).toBeDefined();
    });

    it('discounts at most the units left of the limit', async () => {
      const f = await sellerCreate(flash());
      flashSales.sold = new Map([[f.id, 3]]);
      // Limit 5, 3 sold: 2 units left of the 4 in the cart.
      const out = await quote(request([line(1, 1000n, 4)], { testMode: false }));
      expect(out.totals.goodsDiscount).toBe(600n);
      flashSales.sold = new Map([[f.id, 5]]);
      expect((await quote(request([line(1, 1000n, 4)], { testMode: false }))).applied).toEqual([]);
      flashSales.sold = new Map([[f.id, 99]]);
      expect((await quote(request([line(1, 1000n, 4)], { testMode: false }))).applied).toEqual([]);
    });

    it('runs inside its window in the owning zone, from the injected clock', async () => {
      const f = await sellerCreate(flash());
      flashSales.sold = new Map([[f.id, 0]]);
      const record = promotions.records.get(f.id)!;
      expect(record.startsAt.toString()).toBe('2026-10-25T08:00:00Z');
      expect(record.endsAt?.toString()).toBe('2026-10-25T11:00:00Z');
      expect(record.flashTimeZone).toBe('Australia/Brisbane');
      const cart = request([line(1, 1000n, 1)], { testMode: false });
      expect((await quote(cart)).totals.goodsDiscount).toBe(300n);
      clock.advance(Temporal.Duration.from({ minutes: 61 }));
      expect((await quote(cart)).applied).toEqual([]);
    });

    it('does not start before its window', async () => {
      const f = await sellerCreate(
        flash({
          flash: {
            unitLimit: 5,
            timeZone: 'Australia/Brisbane',
            startsLocal: '2026-10-25T21:30',
            endsLocal: '2026-10-25T23:00',
          },
        }),
      );
      flashSales.sold = new Map([[f.id, 0]]);
      expect((await quote(request([line(1, 1000n, 1)]))).applied).toEqual([]);
      clock.advance(Temporal.Duration.from({ hours: 2 }));
      expect((await quote(request([line(1, 1000n, 1)]))).totals.goodsDiscount).toBe(300n);
    });

    it('can be the platform’s, paid within the commission', async () => {
      const f = await adminCreate(
        platform({
          type: 'FLASH_SALE',
          name: 'Platform flash',
          startsAt: undefined,
          reward: { kind: 'PERCENT', bps: 2000 },
          productIds: [product(1)],
          flash: {
            unitLimit: 10,
            timeZone: 'Pacific/Auckland',
            startsLocal: '2026-10-26T00:00',
            endsLocal: '2026-10-26T06:00',
          },
        }),
      );
      flashSales.sold = new Map([[f.id, 0]]);
      // Auckland is UTC+13 on that date: 00:00 local is 11:00 the day before, UTC.
      expect(promotions.records.get(f.id)?.startsAt.toString()).toBe('2026-10-25T11:00:00Z');
      clock.advance(Temporal.Duration.from({ hours: 2 }));
      const out = await quote(
        request([line(1, 1000n, 2)], { orderCommission: money(150n, currency) }),
      );
      expect(out.totals.goodsDiscount).toBe(150n);
      expect(out.totals.platformShare).toBe(150n);
    });
  });

  describe('single-use batch codes', () => {
    const generate = async (promotionId: Id<'Promotion'>, count: number) => {
      const result = await make(GenerateBatchCodes).execute(admin(), { promotionId, count });
      if (!result.ok) throw new Error(`generate failed: ${JSON.stringify(result.error)}`);
      return result.value;
    };

    it('generates the asked number of unique codes in the Market length and alphabet, storing hashes only', async () => {
      const real = new CryptoBatchCodeCrypto(TEST_CODE_PEPPER);
      deps = { ...deps, codeCrypto: real };
      const p = await adminCreate(batchPromotion());
      const out = await generate(p.id, 50);
      expect(out.codes).toHaveLength(50);
      expect(new Set(out.codes).size).toBe(50);
      for (const c of out.codes) {
        expect(c).toHaveLength(batch.codeLength);
        expect([...c].every((ch) => batch.alphabet.includes(ch))).toBe(true);
      }
      expect(batchCodes.rows.size).toBe(50);
      for (const [hash, row] of batchCodes.rows) {
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
        expect(out.codes).not.toContain(hash);
        expect(row.promotionId).toBe(p.id);
        expect(row.usedAt).toBeNull();
        expect(row.batchId).toBe(out.batchId);
      }
      expect(batchCodes.rows.has(real.hash(out.codes[0]!))).toBe(true);
    });

    it('asks the random source for the Market length and alphabet', async () => {
      const p = await adminCreate(batchPromotion());
      await generate(p.id, 3);
      expect(codeCrypto.requests.length).toBeGreaterThanOrEqual(3);
      expect(new Set(codeCrypto.requests.map((r) => `${r.alphabet}:${r.length}`))).toEqual(
        new Set([`${batch.alphabet}:${batch.codeLength}`]),
      );
    });

    it('draws again when a code collides with a stored one or with another of the batch', async () => {
      const p = await adminCreate(batchPromotion());
      const first = batch.alphabet[0]!.repeat(batch.codeLength);
      const second = batch.alphabet[1]!.repeat(batch.codeLength);
      codeCrypto.script = [first, first, second];
      const one = await generate(p.id, 2);
      expect(one.codes).toEqual([first, second].sort());
      // A later batch that draws a stored code draws once more.
      codeCrypto.script = [first, batch.alphabet[2]!.repeat(batch.codeLength)];
      const two = await generate(p.id, 1);
      expect(two.codes).toEqual([batch.alphabet[2]!.repeat(batch.codeLength)]);
      expect(batchCodes.rows.size).toBe(3);
    });

    it('refuses a count of zero, a fraction, more than a batch and more than a promotion may hold', async () => {
      const p = await adminCreate(batchPromotion());
      for (const count of [0, -1, 1.5, '5', null, batch.maxPerBatch + 1]) {
        const result = await make(GenerateBatchCodes).execute(admin(), {
          promotionId: p.id,
          count,
        });
        expect(result).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      }
      // Fill the promotion to its limit, then one more is too many.
      let left = batch.maxPerPromotion;
      while (left > 0) {
        const n = Math.min(left, batch.maxPerBatch);
        await generate(p.id, n);
        left -= n;
      }
      const over = await make(GenerateBatchCodes).execute(admin(), { promotionId: p.id, count: 1 });
      expect(over).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'count', code: 'too-many' }] },
      });
      expect(batchCodes.rows.size).toBe(batch.maxPerPromotion);
    });

    it('is for admins only, outside an acting-as session', async () => {
      const p = await adminCreate(batchPromotion());
      for (const context of [seller(), customer, actingAs(admin()), system]) {
        const result = await make(GenerateBatchCodes).execute(context, {
          promotionId: p.id,
          count: 1,
        });
        expect(result).toMatchObject({ ok: false });
      }
      expect(batchCodes.rows.size).toBe(0);
    });

    it('answers not-found for an unknown promotion and invalid-state for another type', async () => {
      expect(
        await make(GenerateBatchCodes).execute(admin(), { promotionId: id(0x7777), count: 1 }),
      ).toEqual({ ok: false, error: { code: 'promotions.not-found' } });
      const t = await adminCreate(tiered());
      expect(
        await make(GenerateBatchCodes).execute(admin(), { promotionId: t.id, count: 1 }),
      ).toEqual({ ok: false, error: { code: 'promotions.invalid-state' } });
      expect(
        await make(GenerateBatchCodes).execute(admin(), { promotionId: 'nope', count: 1 }),
      ).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    });

    it('fails closed without the pepper: nothing is generated and no batch code is looked up', async () => {
      const p = await adminCreate(batchPromotion());
      const out = await generate(p.id, 2);
      const [first] = out.codes;
      const publicCode = await adminCreate(
        platform({
          type: 'CART_CODE',
          name: 'Public',
          code: 'PUBLICCODE23',
          reward: { kind: 'PERCENT', bps: 1000 },
        }),
      );
      codeCrypto.available = false;
      expect(
        await make(GenerateBatchCodes).execute(admin(), { promotionId: p.id, count: 1 }),
      ).toEqual({ ok: false, error: { code: 'promotions.unavailable' } });
      expect(batchCodes.rows.size).toBe(2);
      // The batch code gives nothing, but the quote does not fail and a public code still works.
      const lines = [line(1, 5000n, 1)];
      const batchTry = await quote(request(lines, { code: first! }));
      expect(batchTry.applied).toEqual([]);
      expect(batchTry.code).toBe('UNKNOWN');
      const publicTry = await quote(request(lines, { code: 'PUBLICCODE23' }));
      expect(publicTry.applied.map((a) => a.promotionId)).toEqual([publicCode.id]);
    });

    it('refuses a public code whose text is already a generated code', async () => {
      const p = await adminCreate(batchPromotion());
      codeCrypto.script = ['ABCDEFGH2345'];
      await generate(p.id, 1);
      const clash = await make(CreatePromotion).execute(
        admin(),
        platform({
          type: 'CART_CODE',
          name: 'Clash',
          code: 'ABCDEFGH2345',
          reward: { kind: 'PERCENT', bps: 1000 },
        }),
      );
      expect(clash).toEqual({ ok: false, error: { code: 'promotions.code-taken' } });
    });

    it('never generates a code that a public code already has', async () => {
      await adminCreate(
        platform({
          type: 'CART_CODE',
          name: 'Public',
          code: 'ABCDEFGH2345',
          reward: { kind: 'PERCENT', bps: 1000 },
        }),
      );
      const p = await adminCreate(batchPromotion());
      codeCrypto.script = ['ABCDEFGH2345'];
      const out = await generate(p.id, 2);
      expect(out.codes).toHaveLength(2);
      expect(out.codes).not.toContain('ABCDEFGH2345');
    });

    it('lets the single-use code win when a stored public code has the same text', async () => {
      const publicCode = await adminCreate(
        platform({
          type: 'CART_CODE',
          name: 'Public',
          code: 'ABCDEFGH2345',
          reward: { kind: 'FIXED', amountMinor: '900' },
        }),
      );
      const p = await adminCreate(batchPromotion());
      // A clash that exists already (made before the checks): the code is also a generated one.
      await batchCodes.insertMany(market, p.id, id<'PromotionBatch'>(0xb1), [
        codeCrypto.hash('ABCDEFGH2345'),
      ]);
      const out = await quote(request([line(1, 5000n, 1)], { code: 'abcdefgh2345' }));
      expect(out.applied.map((a) => a.promotionId)).toEqual([p.id]);
      expect(out.applied.map((a) => a.promotionId)).not.toContain(publicCode.id);
      expect(out.code).toBe('APPLIED');
      // Once that code is used the public one does not take its place: one code per order.
      batchCodes.markUsed(codeCrypto.hash('ABCDEFGH2345'), clock.now());
      const used = await quote(request([line(1, 5000n, 1)], { code: 'ABCDEFGH2345' }));
      expect(used.applied).toEqual([]);
      expect(used.code).toBe('NOT_APPLIED');
    });

    it('fails closed in a Market that configures no batches', async () => {
      const p = await adminCreate(batchPromotion());
      deps = {
        ...deps,
        policy: { settings: (m) => ({ ...policy.settings(m)!, batchCodes: null }) },
      };
      expect(
        await make(GenerateBatchCodes).execute(admin(), { promotionId: p.id, count: 1 }),
      ).toEqual({ ok: false, error: { code: 'promotions.unavailable' } });
    });

    it('needs a fresh two-step code when the platform budget is above the Market threshold', async () => {
      const big = String(BigInt(rules.platformBudgetStepUpMinor) + 1n);
      stepUp.fresh = true;
      const p = await adminCreate(batchPromotion({ budgetMinor: big }));
      stepUp.spent.length = 0;
      const refused = await make(GenerateBatchCodes).execute(admin(), {
        promotionId: p.id,
        count: 2,
      });
      expect(refused).toEqual({
        ok: false,
        error: {
          code: 'second-factor.required',
          actionKey: 'promotions.platform-funding.approve',
        },
      });
      expect(batchCodes.rows.size).toBe(0);
      stepUp.fresh = true;
      const ok = await generate(p.id, 2);
      expect(ok.codes).toHaveLength(2);
      expect(stepUp.spent).toEqual(['promotions.platform-funding.approve']);
      expect(audit.entries.at(-1)!.after).toMatchObject({ count: 2 });
      expect(Object.keys(audit.entries.at(-1)!.after ?? {})).toContain('stepUpSessionId');
      // The proof was spent: the next call needs another.
      expect(
        await make(GenerateBatchCodes).execute(admin(), { promotionId: p.id, count: 1 }),
      ).toMatchObject({ ok: false, error: { code: 'second-factor.required' } });
    });

    it('needs no second factor at or below the threshold, and audits the count, never a code', async () => {
      const p = await adminCreate(batchPromotion());
      const out = await generate(p.id, 3);
      expect(stepUp.spent).toEqual([]);
      const entry = audit.entries.at(-1)!;
      expect(entry.action).toBe('promotions.batch-codes.generated');
      expect(entry.after).toMatchObject({ count: 3, batchId: out.batchId });
      const text = JSON.stringify(audit.entries, (_k, v: unknown) =>
        typeof v === 'bigint' ? String(v) : v,
      );
      for (const c of out.codes) expect(text).not.toContain(c);
    });

    it('summarises the codes of a promotion by count, for an admin', async () => {
      const p = await adminCreate(batchPromotion());
      const out = await generate(p.id, 4);
      batchCodes.markUsed(codeCrypto.hash(out.codes[0]!), clock.now());
      const summary = await make(ViewBatchCodeSummary).execute(admin(), { promotionId: p.id });
      expect(summary).toEqual({
        ok: true,
        value: { promotionId: p.id, total: 4, used: 1, maxPerPromotion: batch.maxPerPromotion },
      });
      expect(
        await make(ViewBatchCodeSummary).execute(seller(), { promotionId: p.id }),
      ).toMatchObject({
        ok: false,
      });
    });

    it('applies an unused code once per order and treats a used one as not applicable', async () => {
      const p = await adminCreate(batchPromotion());
      const [a, b] = (await generate(p.id, 2)).codes;
      const cart = (entered: string | null) => request([line(1, 5000n, 1)], { code: entered });
      const first = await quote(cart(a!));
      expect(first.code).toBe('APPLIED');
      expect(first.totals.goodsDiscount).toBe(500n);
      // Typed in lower case with spaces: the same code.
      expect((await quote(cart(` ${a!.toLowerCase()} `))).code).toBe('APPLIED');
      // The other code of the batch is a different order's.
      expect((await quote(cart(b!))).totals.goodsDiscount).toBe(500n);
      // Redeemed by an order (package T2 marks it): the code is known and gives nothing.
      batchCodes.markUsed(codeCrypto.hash(a!), clock.now());
      const used = await quote(cart(a!));
      expect(used.code).toBe('NOT_APPLIED');
      expect(used.totals.goodsDiscount).toBe(0n);
      expect((await quote(cart(b!))).code).toBe('APPLIED');
      // An unknown code and no code give nothing.
      expect((await quote(cart('NOSUCHCODE0'))).code).toBe('UNKNOWN');
      const none = await quote(cart(null));
      expect(none.code).toBe('NONE');
      expect(none.totals.goodsDiscount).toBe(0n);
    });

    it('does not apply the code of a paused promotion', async () => {
      const p = await adminCreate(batchPromotion());
      const [a] = (await generate(p.id, 1)).codes;
      await make(PausePromotion).execute(admin(), { promotionId: p.id });
      const paused = await quote(request([line(1, 5000n, 1)], { code: a! }));
      expect(paused.totals.goodsDiscount).toBe(0n);
    });

    it('does not stack with the first-order discount: the larger applies', async () => {
      const p = await adminCreate(batchPromotion());
      const [a] = (await generate(p.id, 1)).codes;
      const first = await make(SetFirstOrderSettings).execute(admin(), {
        enabled: true,
        kind: 'FIXED',
        amountMinor: '800',
        minSpendMinor: '0',
        monthlyBudgetMinor: '100000',
      });
      expect(first.ok).toBe(true);
      const out = await quote(request([line(1, 5000n, 1)], { code: a!, isFirstOrder: true }));
      expect(out.totals.goodsDiscount).toBe(800n);
      expect(out.code).toBe('NOT_APPLIED');
    });
  });
});
