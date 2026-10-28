import { ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { AllowingStepUp, payoutStores } from '../../../../test/support/commission-payouts-fakes';
import {
  FakeSellerNames,
  RecordingSecurityEvents,
} from '../../../../test/support/commission-payouts-dispute-fakes';
import {
  FixedPayoutPolicy,
  MemoryPayouts,
  NetLedger,
  ScriptedAccess,
  ScriptedPayments,
  ScriptedPrerequisites,
} from '../../../../test/support/commission-payouts-payout-fakes';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { StepUpProofConsumer } from '../../../platform/authz';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import type { EventDelivery } from '../../../platform/events/event-delivery';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { COMMISSION_PAYOUTS_AUDIT_ACTIONS } from '../domain/audit';
import { openPayout, type Payout, type PayoutItem } from '../domain/payout';
import { latestSlot } from '../domain/payout-schedule';
import { UnwiredPayoutPrerequisites } from '../infrastructure/unwired-payout-prerequisites';
import { spendStepUp } from './step-up';
import type { PayoutTermsOverrideRecord } from './ports/payout-terms.repository';
import { ConfigCommissionPolicy } from '../infrastructure/config-commission-policy';
import { ConfigPayoutTermsPolicy } from '../infrastructure/config-payout-terms-policy';
import type { PayoutDependencies } from './payout-dependencies';
import { APPROVAL_ALERT_AFTER } from './payout-run-flow';
import { ApplyTransferChange } from './use-cases/apply-transfer-change.use-case';
import { ApprovePayout } from './use-cases/approve-payout.use-case';
import { ListOwnPayoutHolds } from './use-cases/list-own-payout-holds.use-case';
import { ListOwnPayouts } from './use-cases/list-own-payouts.use-case';
import { ListPayouts } from './use-cases/list-payouts.use-case';
import { ReconcileInstructions } from './use-cases/reconcile-instructions.use-case';
import { RunPayouts } from './use-cases/run-payouts.use-case';
import { ViewNextPayout } from './use-cases/view-next-payout.use-case';
import { ViewPayout } from './use-cases/view-payout.use-case';

// Package 6d: the payout run, the approval, the reconciliation with payments and what admins and
// sellers see, on both Market fixtures. AU: AUD, Tuesday 10:00 in Sydney, minimum 5000, AUTO with
// a manual first payout. ZZ: JPY, Thursday and Friday 14:30 in Tokyo, minimum 3000, MANUAL.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-14T10:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const SELLER_A = id<'Seller'>(0x51);
const SELLER_B = id<'Seller'>(0x52);
const ADMIN = id<'Account'>(0xad);
const ORDER_1 = id<'SellerOrder'>(0x201);
const ORDER_2 = id<'SellerOrder'>(0x202);
const PRIOR_ORDER = id<'SellerOrder'>(0x2f0);
const TRANSFER = '01990000-0000-7000-8000-0000000000e1';
const PRIOR_TRANSFER = '01990000-0000-7000-8000-0000000000e0';
const json = (value: unknown) =>
  JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
const ACTIONS = new Set<string>(COMMISSION_PAYOUTS_AUDIT_ACTIONS.map((a) => a.action));
const delivery = (n: number): EventDelivery => ({
  eventId: id<'event'>(0xe00 + n),
  subscriber: 'commission-payouts.apply-transfer-change',
  attempt: 1,
});

const MARKET_FIXTURES = {
  AU: {
    zone: 'Australia/Sydney',
    currency: 'AUD',
    runAt: '2026-10-20T00:00:00Z',
    slot: '2026-10-19T23:00:00Z',
    minimum: 5000n,
    firstPayoutManual: true,
  },
  ZZ: {
    zone: 'Asia/Tokyo',
    currency: 'JPY',
    runAt: '2026-10-15T06:00:00Z',
    slot: '2026-10-15T05:30:00Z',
    minimum: 3000n,
    firstPayoutManual: false,
  },
} as const;

class RecordingAudit implements AuditWriter {
  readonly entries: AuditEntry[] = [];
  record(_context: CallContext, entry: AuditEntry): Promise<void> {
    if (!ACTIONS.has(entry.action)) throw new Error(`audit: unknown action ${entry.action}`);
    this.entries.push(entry);
    return Promise.resolve();
  }
}

class RefusingStepUp implements StepUpProofConsumer {
  calls = 0;
  consume(_context: CallContext, actionKey: string) {
    this.calls += 1;
    return Promise.resolve({
      ok: false as const,
      error: { code: 'second-factor.required' as const, actionKey },
    });
  }
}

const must = <T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
};

describe.each([['AU'], ['ZZ']] as const)('payouts in market %s', (code) => {
  const fixture = MARKET_FIXTURES[code];
  const market = testMarketContext(code, 'default');
  const otherMarket = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
  const clock = new FixedClock(T0);
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const actorOf = (
    m: MarketContext,
    population: 'admin' | 'seller',
    sellerId: Id<'Seller'> | null,
  ) =>
    testCallContext(
      m,
      testAuthenticatedActor(m, {
        population,
        accountId: population === 'admin' ? ADMIN : id<'Account'>(0xa1),
        sessionId: id<'Session'>(0x61),
        sellerId,
      }),
      `cp-${population}-abcd`,
    );
  const admin = actorOf(market, 'admin', null);
  const sellerCtx = actorOf(market, 'seller', SELLER_A);
  const sellerBCtx = actorOf(market, 'seller', SELLER_B);
  const system = testCallContext(market, 'system', 'cp-system-abcd');

  let audit: RecordingAudit;
  let stores: ReturnType<typeof payoutStores>;
  let payouts: MemoryPayouts;
  let ledger: NetLedger;
  let access: ScriptedAccess;
  let prerequisites: ScriptedPrerequisites;
  let payments: ScriptedPayments;
  let security: RecordingSecurityEvents;
  let names: FakeSellerNames;
  let deps: PayoutDependencies;
  let seq: number;

  beforeEach(() => {
    clock.set(Temporal.Instant.from(fixture.runAt));
    audit = new RecordingAudit();
    stores = payoutStores(new ConfigPayoutTermsPolicy(markets));
    payouts = new MemoryPayouts();
    ledger = new NetLedger();
    access = new ScriptedAccess();
    prerequisites = new ScriptedPrerequisites();
    payments = new ScriptedPayments();
    payments.instructAnswer = { kind: 'accepted', transferExecutionId: TRANSFER };
    security = new RecordingSecurityEvents();
    names = new FakeSellerNames();
    seq = 0;
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      payouts,
      cursors: stores.cursors,
      ledger: ledger.asRepository(),
      anchors: stores.anchors,
      holds: stores.holds,
      terms: stores.terms,
      policy: new ConfigCommissionPolicy(markets),
      payoutPolicy: new FixedPayoutPolicy(
        { AU: 'Australia/Sydney', ZZ: 'Asia/Tokyo' },
        { AU: 'AUD', ZZ: 'JPY' },
      ),
      access,
      prerequisites,
      payments,
      sellerNames: names,
      securityEvents: security,
      stepUp: stores.stepUp,
      audit,
      ids: new SequenceIdGenerator(clock),
      clock,
    };
  });

  // --- fixtures ---------------------------------------------------------------------------------

  /** A seller who can be paid: approved, in its zone, with a ready account and a cursor. */
  const addSeller = async (sellerId: Id<'Seller'> = SELLER_A) => {
    access.eligibleSellers.add(sellerId);
    access.zonesBySeller.set(sellerId, { zone: fixture.zone, provisional: false });
    payments.ready.add(sellerId);
    await stores.cursors.ensure(market, sellerId, T0);
  };
  /** A delivered seller order worth `net`, eligible since T0. */
  const addOrder = async (
    sellerOrderId: Id<'SellerOrder'>,
    net: bigint,
    sellerId: Id<'Seller'> = SELLER_A,
  ) => {
    ledger.set(sellerId, sellerOrderId, net);
    await stores.anchors.insertIfAbsent(market, {
      sellerOrderId,
      orderId: id<'Order'>(0x101),
      sellerId,
      deliveredAt: T0,
      source: 'carrier',
      holdDaysApplied: 7,
      eligibleAt: T0,
      recordedAt: T0,
    });
  };
  /** Terms that pay at once (AUTO) and a payout of an earlier slot that was paid. */
  const makeAuto = async (taken: bigint, netNow: bigint = taken, sellerId = SELLER_A) => {
    const record: PayoutTermsOverrideRecord = {
      sellerId,
      override: {
        weekdays: null,
        localTime: null,
        holdDaysCarrier: null,
        holdDaysSellerClick: null,
        minimumMinor: null,
        approvalMode: 'AUTO',
      },
      version: 1,
      updatedAt: T0,
      updatedBy: ADMIN,
    };
    stores.termsOverrides.rows.set(`${market.marketId}:${sellerId}`, record);
    ledger.set(sellerId, PRIOR_ORDER, netNow);
    const items: PayoutItem[] = [{ sellerOrderId: PRIOR_ORDER, amount: taken }];
    const base = openPayout({
      id: id<'Payout'>(0x900),
      sellerId,
      currency: fixture.currency,
      items,
      netted: 0n,
      approvalMode: 'AUTO',
      firstPayout: false,
      minimum: fixture.minimum,
      slotAt: T0,
      now: T0,
    });
    await payouts.insert(
      market,
      { ...base, state: 'paid', transferExecutionId: PRIOR_TRANSFER },
      items,
    );
  };
  const run = async () => must(await new RunPayouts(gate, deps).execute(system, {}));
  const reconcile = async () =>
    must(await new ReconcileInstructions(gate, deps).execute(system, {}));
  const only = (): Payout => {
    const rows = [...payouts.rows.values()].filter((row) => row.id !== id<'Payout'>(0x900));
    expect(rows).toHaveLength(1);
    return rows[0]!;
  };
  const cursor = async (sellerId = SELLER_A) => (await stores.cursors.find(market, sellerId))!;
  const hold = (
    reason: 'dispute' | 'refund-pending' | 'admin-review' | 'seller-suspended',
    sellerOrderId: Id<'SellerOrder'> | null,
  ) =>
    stores.holds.insertIfAbsent(market, {
      id: id<'PayoutHold'>(0x300 + (seq += 1)),
      sellerId: SELLER_A,
      sellerOrderId,
      reason,
      origin: 'system',
      sourceRef: `src-${seq}`,
      placedBy: null,
      placedAt: T0,
      releasedAt: null,
      releasedBy: null,
      releaseReason: null,
    });
  const alerts = () =>
    security.events.filter((event) => event.type === 'commission-payouts.payout.alert');

  // --- the run ----------------------------------------------------------------------------------

  describe('the payout run', () => {
    it("makes the seller's first payout wait for an admin and instructs nothing", async () => {
      await addSeller();
      await addOrder(ORDER_1, 20000n);
      const summary = await run();
      expect(summary).toMatchObject({ evaluated: 1, created: 1, instructed: 0 });
      const payout = only();
      expect(payout).toMatchObject({
        state: 'awaiting-approval',
        approvalMode: 'MANUAL',
        approvalReason: fixture.firstPayoutManual ? 'first-payout' : 'terms',
        gross: 20000n,
        netted: 0n,
        transfer: 20000n,
        currency: fixture.currency,
        sellerId: SELLER_A,
        minimum: fixture.minimum,
      });
      expect(payout.slotAt.toString()).toBe(Temporal.Instant.from(fixture.slot).toString());
      expect(payments.instructed).toEqual([]);
      const row = await cursor();
      expect(row.lastSlotAt.toString()).toBe(payout.slotAt.toString());
      expect(row.blockReason).toBe('awaiting-approval');
      expect(stores.cursors.locks).toBeGreaterThan(0);
    });

    it('does not make a second payout while the first one is live', async () => {
      await addSeller();
      await addOrder(ORDER_1, 20000n);
      await run();
      await addOrder(ORDER_2, 20000n);
      clock.advance(Temporal.Duration.from({ hours: 2 }));
      const summary = await run();
      expect(summary.created).toBe(0);
      expect(payouts.rows.size).toBe(1);
      expect((await cursor()).blockReason).toBe('awaiting-approval');
    });

    it('instructs at once when the seller was paid before and the terms are AUTO', async () => {
      await addSeller();
      await makeAuto(10000n);
      await addOrder(ORDER_1, 20000n);
      const summary = await run();
      expect(summary).toMatchObject({ created: 1, instructed: 1 });
      const payout = only();
      expect(payout).toMatchObject({
        state: 'instructed',
        approvalMode: 'AUTO',
        approvalReason: null,
        transferExecutionId: TRANSFER,
      });
      // The instruction key is the payout id, stored before the call; one call, the transfer amount.
      expect(payments.instructed).toEqual([
        {
          instructionKey: payout.id,
          sellerId: SELLER_A,
          amountMinor: 20000n,
          currency: fixture.currency,
        },
      ]);
    });

    it('takes back what the seller owes: a refund after payout is netted, the rest transferred', async () => {
      await addSeller();
      // 10000 was paid for the earlier order, which is worth 4000 now: 6000 is owed.
      await makeAuto(10000n, 4000n);
      await addOrder(ORDER_1, 20000n);
      await run();
      expect(only()).toMatchObject({ gross: 20000n, netted: 6000n, transfer: 14000n });
      expect(payments.instructed.map((call) => call.amountMinor)).toEqual([14000n]);
    });

    it('settles by netting when the debt takes everything, and sends nothing', async () => {
      await addSeller();
      await makeAuto(30000n, 0n);
      await addOrder(ORDER_1, 20000n);
      const summary = await run();
      expect(summary).toMatchObject({ settledByNetting: 1, created: 0, instructed: 0 });
      expect(only()).toMatchObject({ state: 'settled-by-netting', transfer: 0n, netted: 20000n });
      expect(payments.instructed).toEqual([]);
      // The next payout only owes what is left.
      await addOrder(ORDER_2, 20000n);
      clock.advance(Temporal.Duration.from({ hours: 192 }));
      await run();
      const next = [...payouts.rows.values()].find(
        (row) => row.state !== 'paid' && row.gross === 20000n && row.netted === 10000n,
      );
      expect(next).toMatchObject({ netted: 10000n, transfer: 10000n });
    });

    it('moves the cursor but keeps the money when it is below the minimum', async () => {
      await addSeller();
      await makeAuto(10000n);
      await addOrder(ORDER_1, fixture.minimum - 1n);
      const summary = await run();
      expect(summary).toMatchObject({ created: 0, blocked: 1 });
      expect(payouts.rows.size).toBe(1);
      const row = await cursor();
      expect(row.blockReason).toBe('below-minimum');
      expect(row.lastSlotAt.toString()).toBe(Temporal.Instant.from(fixture.slot).toString());
      // The order is still free for the next slot.
      expect((await payouts.position(market, SELLER_A)).itemAmounts.has(ORDER_1)).toBe(false);
    });

    it('does nothing before the slot, and records when the next one is', async () => {
      await addSeller();
      await addOrder(ORDER_1, 20000n);
      clock.set(Temporal.Instant.from(fixture.slot).subtract({ hours: 1 }));
      await run();
      expect(payouts.rows.size).toBe(0);
      expect((await cursor()).nextSlotAt?.toString()).toBe(
        Temporal.Instant.from(fixture.slot).toString(),
      );
    });

    it("keeps the slot at the same local time across the seller zone's daylight-saving change", async () => {
      await addSeller();
      // Melbourne moves its clocks on Sunday 4 October 2026 (02:00 to 03:00).
      access.zonesBySeller.set(SELLER_A, { zone: 'Australia/Melbourne', provisional: false });
      const terms = must(await stores.terms.resolve(market, SELLER_A)).terms;
      const nextSlotFrom = async (at: string) => {
        clock.set(Temporal.Instant.from(at));
        await stores.cursors.invalidate(market, SELLER_A, clock.now());
        await run();
        return (await cursor()).nextSlotAt!;
      };
      const before = await nextSlotFrom('2026-09-01T00:00:00Z');
      const after = await nextSlotFrom('2026-10-06T00:00:00Z');
      const local = (slot: Temporal.Instant) => slot.toZonedDateTimeISO('Australia/Melbourne');
      expect(local(before).toPlainTime().toString()).toBe(
        Temporal.PlainTime.from(terms.localTime).toString(),
      );
      expect(local(after).toPlainTime().toString()).toBe(
        Temporal.PlainTime.from(terms.localTime).toString(),
      );
      // The same local time, one hour earlier in UTC after the clocks went forward.
      expect(local(before).offsetNanoseconds).toBe(10 * 3600e9);
      expect(local(after).offsetNanoseconds).toBe(11 * 3600e9);
    });

    it('makes one payout for several missed slots, at the latest one', async () => {
      await addSeller();
      await addOrder(ORDER_1, 20000n);
      clock.set(Temporal.Instant.from(fixture.runAt).add({ hours: 384 }));
      await run();
      const terms = must(await stores.terms.resolve(market, SELLER_A)).terms;
      const latest = latestSlot(
        { weekdays: terms.weekdays, localTime: terms.localTime },
        fixture.zone,
        T0,
        clock.now(),
      )!;
      expect(payouts.rows.size).toBe(1);
      expect(only().slotAt.toString()).toBe(latest.toString());
    });

    it('skips a seller with no approved zone, alerts once and never uses the Market zone', async () => {
      await addSeller();
      await addOrder(ORDER_1, 20000n);
      access.zonesBySeller.delete(SELLER_A);
      await run();
      expect(payouts.rows.size).toBe(0);
      expect(await cursor()).toMatchObject({ blockReason: 'zone-missing', nextSlotAt: null });
      expect(alerts()).toHaveLength(1);
      expect(alerts()[0]!.payload).toEqual({ sellerId: SELLER_A, reason: 'zone-missing' });
      clock.advance(Temporal.Duration.from({ hours: 2 }));
      await run();
      expect(alerts()).toHaveLength(1);
      // A draft zone is no zone either.
      access.zonesBySeller.set(SELLER_A, { zone: fixture.zone, provisional: true });
      clock.advance(Temporal.Duration.from({ hours: 2 }));
      await run();
      expect(payouts.rows.size).toBe(0);
    });

    it.each([
      ['the account is not ready', 'account-not-ready'],
      ['the seller is not approved', 'payouts-paused'],
      ['the owner second factor is missing', 'second-factor-required'],
    ] as const)('holds the slot open when %s, then pays once it clears', async (_label, reason) => {
      await addSeller();
      await makeAuto(10000n);
      await addOrder(ORDER_1, 20000n);
      if (reason === 'account-not-ready') payments.ready.delete(SELLER_A);
      if (reason === 'payouts-paused') access.eligibleSellers.delete(SELLER_A);
      if (reason === 'second-factor-required') prerequisites.answer = 'second-factor-required';
      const before = await cursor();
      await run();
      expect(payouts.rows.size).toBe(1);
      const blocked = await cursor();
      expect(blocked.blockReason).toBe(reason);
      expect(blocked.lastSlotAt.toString()).toBe(before.lastSlotAt.toString());
      expect(payments.instructed).toEqual([]);

      payments.ready.add(SELLER_A);
      access.eligibleSellers.add(SELLER_A);
      prerequisites.answer = 'ok';
      clock.advance(Temporal.Duration.from({ hours: 1 }));
      await run();
      expect(only().state).toBe('instructed');
      expect(only().slotAt.toString()).toBe(Temporal.Instant.from(fixture.slot).toString());
    });

    it('pays nothing against the live provider while the prerequisites are unwired', async () => {
      await addSeller();
      await makeAuto(10000n);
      await addOrder(ORDER_1, 20000n);
      deps = { ...deps, prerequisites: new UnwiredPayoutPrerequisites(true) };
      const summary = await run();
      expect(summary).toMatchObject({ created: 0, instructed: 0, skipped: 1 });
      expect(payments.instructed).toEqual([]);
      expect([...payouts.rows.values()].filter((row) => row.state !== 'paid')).toEqual([]);
    });

    it('decides nothing when another module cannot answer', async () => {
      await addSeller();
      await addOrder(ORDER_1, 20000n);
      access.unavailable = true;
      expect(await run()).toMatchObject({ skipped: 1, created: 0 });
      access.unavailable = false;
      payments.unavailable = true;
      expect(await run()).toMatchObject({ skipped: 1, created: 0 });
      payments.unavailable = false;
      prerequisites.answer = 'unavailable';
      expect(await run()).toMatchObject({ skipped: 1, created: 0 });
      expect(payouts.rows.size).toBe(0);
      expect((await cursor()).lastSlotAt.toString()).toBe(T0.toString());
    });

    it('keeps the money of a held seller order out, and of a held seller altogether', async () => {
      await addSeller();
      await makeAuto(10000n);
      await addOrder(ORDER_1, 20000n);
      await addOrder(ORDER_2, 9000n);
      await hold('dispute', ORDER_1);
      await run();
      expect(only()).toMatchObject({ gross: 9000n });

      // A second seller: a hold on the whole seller pays nothing.
      await addSeller(SELLER_B);
      await addOrder(id<'SellerOrder'>(0x211), 20000n, SELLER_B);
      await stores.holds.insertIfAbsent(market, {
        id: id<'PayoutHold'>(0x3b0),
        sellerId: SELLER_B,
        sellerOrderId: null,
        reason: 'seller-suspended',
        origin: 'system',
        sourceRef: 'suspended',
        placedBy: null,
        placedAt: T0,
        releasedAt: null,
        releasedBy: null,
        releaseReason: null,
      });
      clock.advance(Temporal.Duration.from({ hours: 2 }));
      await run();
      expect(await cursor(SELLER_B)).toMatchObject({ blockReason: 'payouts-paused' });
      expect(
        [...payouts.rows.values()].filter(
          (row) => row.sellerId === SELLER_B && row.state !== 'paid',
        ),
      ).toEqual([]);
    });

    it('works at most 100 sellers per batch', async () => {
      const limits: number[] = [];
      const listDue = stores.cursors.listDue.bind(stores.cursors);
      stores.cursors.listDue = (m, now, stale, limit) => {
        limits.push(limit);
        return listDue(m, now, stale, limit);
      };
      for (let n = 0; n < 120; n += 1) {
        const sellerId = id<'Seller'>(0x1000 + n);
        await addSeller(sellerId);
        await addOrder(id<'SellerOrder'>(0x5000 + n), 20000n, sellerId);
      }
      const summary = await run();
      expect(summary).toMatchObject({ evaluated: 120, created: 120 });
      expect(Math.max(...limits)).toBe(100);
      expect(limits.length).toBeGreaterThanOrEqual(2);
    });

    it('does not read or write another Market', async () => {
      await addSeller();
      await addOrder(ORDER_1, 20000n);
      const elsewhere = testCallContext(otherMarket, 'system', 'cp-system-other');
      must(await new RunPayouts(gate, deps).execute(elsewhere, {}));
      expect(payouts.rows.size).toBe(0);
    });
  });

  // --- sending ----------------------------------------------------------------------------------

  describe('instructing the transfer', () => {
    const autoSetup = async () => {
      await addSeller();
      await makeAuto(10000n);
      await addOrder(ORDER_1, 20000n);
    };

    it('closes a refused payout as not sent and frees its seller orders for a new payout', async () => {
      await autoSetup();
      payments.instructAnswer = { kind: 'refused', code: 'payments.transfer.account-not-ready' };
      const summary = await run();
      expect(summary).toMatchObject({ notSent: 1, instructed: 0 });
      const first = only();
      expect(first).toMatchObject({
        state: 'not-sent',
        outcomeCode: 'payments.transfer.account-not-ready',
      });
      // The seller can act on this one; no operator alert.
      expect((await cursor()).blockReason).toBe('account-not-ready');
      expect(alerts()).toEqual([]);

      payments.instructAnswer = { kind: 'accepted', transferExecutionId: TRANSFER };
      payments.ready.add(SELLER_A);
      // The slot was answered: the money is proposed again at the next one.
      clock.advance(Temporal.Duration.from({ hours: 192 }));
      await run();
      const second = [...payouts.rows.values()].find((row) => row.state === 'instructed')!;
      // A retry is a new payout with a new instruction key.
      expect(second.id).not.toBe(first.id);
      expect(second.gross).toBe(20000n);
    });

    it('raises an operator alert for a refusal the seller cannot act on, and shows a pause', async () => {
      await autoSetup();
      payments.instructAnswer = { kind: 'refused', code: 'payments.transfer.over-limit' };
      await run();
      expect((await cursor()).blockReason).toBe('payouts-paused');
      expect(alerts().map((event) => event.payload)).toEqual([
        { sellerId: SELLER_A, reason: 'transfer-refused' },
      ]);
    });

    it('unwinds a payout whose seller was suspended after the gate, minutes before the send', async () => {
      await autoSetup();
      // Call 1 is the gate of the evaluation; call 2 is the re-check right before the send. The
      // suspension lands in between, the way a delayed seller-suspended event would.
      access.onEligible = (call) => {
        if (call === 2) {
          clock.advance(Temporal.Duration.from({ minutes: 4 }));
          access.eligibleSellers.delete(SELLER_A);
        }
      };
      const summary = await run();
      expect(payments.instructed).toEqual([]);
      const unwound = only();
      expect(payments.abandoned).toEqual([unwound.id]);
      expect(summary).toMatchObject({ notSent: 1, instructed: 0 });
      // Nothing was sent, so no quarantine: closed at once and the seller orders are free.
      expect(unwound).toMatchObject({ state: 'not-sent', outcomeCode: 'payout-unwound' });
      expect(unwound.abandonedAt).toBeNull();
      expect((await payouts.position(market, SELLER_A)).itemAmounts.has(ORDER_1)).toBe(false);
    });

    it('unwinds when the re-check cannot be answered, and sends nothing', async () => {
      await autoSetup();
      access.onEligible = (call) => {
        if (call === 2) access.unavailable = true;
      };
      await run();
      expect(payments.instructed).toEqual([]);
      expect(only()).toMatchObject({ state: 'not-sent', outcomeCode: 'payout-unwound' });
    });

    it('leaves the payout instructing when the fence cannot be confirmed', async () => {
      await autoSetup();
      access.onEligible = (call) => {
        if (call === 2) access.eligibleSellers.delete(SELLER_A);
      };
      payments.abandonAnswer = { kind: 'in-flight' };
      const summary = await run();
      expect(payments.instructed).toEqual([]);
      expect(summary.pendingAnswer).toBe(1);
      expect(only().state).toBe('instructing');
    });

    it('takes a transfer that was already sent when the fence is refused', async () => {
      await autoSetup();
      access.onEligible = (call) => {
        if (call === 2) access.eligibleSellers.delete(SELLER_A);
      };
      payments.abandonAnswer = { kind: 'already-sent', transferExecutionId: TRANSFER };
      await run();
      expect(only()).toMatchObject({ state: 'instructed', transferExecutionId: TRANSFER });
    });

    it('keeps a payout instructing on idempotency.key-reused, and raises an alert', async () => {
      await autoSetup();
      payments.instructAnswer = { kind: 'refused', code: 'idempotency.key-reused' };
      const summary = await run();
      expect(summary).toMatchObject({ notSent: 0, pendingAnswer: 1 });
      expect(only().state).toBe('instructing');
      expect((await payouts.position(market, SELLER_A)).itemAmounts.has(ORDER_1)).toBe(true);
      expect(alerts().map((event) => event.payload)).toEqual([
        { sellerId: SELLER_A, reason: 'transfer-refused' },
      ]);
    });

    it('leaves an unanswered payout instructing, and never sends it again from the run', async () => {
      await autoSetup();
      payments.instructAnswer = 'unavailable';
      const summary = await run();
      expect(summary).toMatchObject({ pendingAnswer: 1, instructed: 0 });
      expect(only().state).toBe('instructing');
      clock.advance(Temporal.Duration.from({ hours: 2 }));
      await run();
      expect(payments.instructed).toHaveLength(1);
    });
  });

  // --- approval ---------------------------------------------------------------------------------

  describe('approving a payout', () => {
    const waiting = async () => {
      await addSeller();
      await addOrder(ORDER_1, 20000n);
      await run();
      return only();
    };
    const approve = (payoutId: unknown, amountMinor: unknown, context: CallContext = admin) =>
      new ApprovePayout(gate, deps).execute(context, { payoutId, amountMinor });

    it('binds the echoed amount, audits, spends the step-up once, and leaves the sending to the worker', async () => {
      const payout = await waiting();
      const result = must(await approve(payout.id, '20000'));
      expect(result).toMatchObject({ state: 'approved', approvedBy: ADMIN });
      expect(result.transfer).toEqual({ amountMinor: 20000n, currency: fixture.currency });
      expect(only()).toMatchObject({
        state: 'approved',
        approval: { approvedBy: ADMIN, approvedTransfer: 20000n },
      });
      expect(stores.stepUp.spent).toEqual(['commission-payouts.payout.approve']);
      expect(audit.entries.map((entry) => entry.action)).toEqual([
        'commission-payouts.payout.approve',
      ]);
      expect(json(audit.entries)).not.toContain('secret');
      expect(payments.instructed).toEqual([]);

      // The worker instructs it at its next run, after the checks of that day.
      clock.advance(Temporal.Duration.from({ minutes: 15 }));
      const summary = await run();
      expect(summary.instructed).toBe(1);
      expect(only().state).toBe('instructed');
      expect(payments.instructed).toHaveLength(1);
    });

    it('refuses an amount that is not the transfer, without spending the proof', async () => {
      const payout = await waiting();
      const result = await approve(payout.id, '19999');
      expect(result).toEqual({
        ok: false,
        error: { code: 'commission-payouts.payout.amount-changed' },
      });
      expect(stores.stepUp.spent).toEqual([]);
      expect(only().state).toBe('awaiting-approval');
      expect(audit.entries).toEqual([]);
    });

    it('refuses a payout that does not wait, and approving twice', async () => {
      const payout = await waiting();
      must(await approve(payout.id, '20000'));
      expect(await approve(payout.id, '20000')).toEqual({
        ok: false,
        error: { code: 'commission-payouts.payout.not-awaiting-approval' },
      });
      expect(stores.stepUp.spent).toHaveLength(1);
    });

    it('answers the same for an unknown payout and one of another Market', async () => {
      const payout = await waiting();
      const unknown = await approve(id<'Payout'>(0xdead), '20000');
      const foreign = await approve(payout.id, '20000', actorOf(otherMarket, 'admin', null));
      expect(unknown).toEqual({
        ok: false,
        error: { code: 'commission-payouts.payout-not-found' },
      });
      expect(foreign).toEqual(unknown);
      expect(only().state).toBe('awaiting-approval');
    });

    it('validates the id and the amount text before anything else', async () => {
      const result = await approve('x', 20000);
      expect(result).toEqual({
        ok: false,
        error: {
          code: 'validation.failed',
          fields: [
            { path: 'payoutId', code: 'format' },
            { path: 'amountMinor', code: 'required' },
          ],
        },
      });
      expect(await approve(id<'Payout'>(1), '-5')).toMatchObject({
        ok: false,
        error: { fields: [{ path: 'amountMinor', code: 'format' }] },
      });
    });

    it('is refused for a seller, and spends no proof there', async () => {
      const payout = await waiting();
      expect(await approve(payout.id, '20000', sellerCtx)).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(stores.stepUp.spent).toEqual([]);
      expect(only().state).toBe('awaiting-approval');
    });

    it('returns the step-up refusal as given and approves nothing', async () => {
      const payout = await waiting();
      const refusing = new RefusingStepUp();
      deps = { ...deps, stepUp: refusing };
      expect(await approve(payout.id, '20000')).toEqual({
        ok: false,
        error: {
          code: 'second-factor.required',
          actionKey: 'commission-payouts.payout.approve',
        },
      });
      expect(refusing.calls).toBe(1);
      expect(only().state).toBe('awaiting-approval');
      expect(audit.entries).toEqual([]);
    });

    it.each([
      ['a hold is placed', 'voided.hold'],
      ['a seller order is refunded', 'voided.amount-changed'],
    ] as const)('voids a waiting payout when %s', async (_label, outcome) => {
      const payout = await waiting();
      if (outcome === 'voided.hold') await hold('dispute', ORDER_1);
      else ledger.set(SELLER_A, ORDER_1, 15000n);
      const summary = await run();
      expect(summary.voided).toBe(1);
      expect(only()).toMatchObject({ id: payout.id, state: 'voided', outcomeCode: outcome });
      expect(payments.instructed).toEqual([]);
    });

    it('voids an approved payout whose account stopped being ready, before sending', async () => {
      const payout = await waiting();
      must(await approve(payout.id, '20000'));
      payments.ready.delete(SELLER_A);
      await run();
      expect(only()).toMatchObject({ state: 'voided', outcomeCode: 'voided.account-not-ready' });
      expect(payments.instructed).toEqual([]);
    });

    it('voids an approved payout whose receivable grew since the approval', async () => {
      await addSeller();
      await makeAuto(10000n);
      const key = `${market.marketId}:${SELLER_A}`;
      stores.termsOverrides.rows.set(key, {
        ...stores.termsOverrides.rows.get(key)!,
        override: { ...stores.termsOverrides.rows.get(key)!.override, approvalMode: 'MANUAL' },
      });
      await addOrder(ORDER_1, 20000n);
      await run();
      const payout = only();
      expect(payout.state).toBe('awaiting-approval');
      must(await approve(payout.id, '20000'));
      // A refund on an order that is not in the payout: the seller now owes 3000.
      ledger.set(SELLER_A, PRIOR_ORDER, 7000n);
      clock.advance(Temporal.Duration.from({ minutes: 15 }));
      await run();
      expect(only()).toMatchObject({ state: 'voided', outcomeCode: 'voided.amount-changed' });
      expect(payments.instructed).toEqual([]);
    });

    it('alerts once when an approval has waited a day', async () => {
      const payout = await waiting();
      clock.set(payout.stateChangedAt.add(APPROVAL_ALERT_AFTER).add({ minutes: 5 }));
      await run();
      expect(alerts().map((event) => event.payload)).toEqual([
        { sellerId: SELLER_A, reason: 'approval-waiting' },
      ]);
      clock.advance(Temporal.Duration.from({ minutes: 15 }));
      await run();
      expect(alerts()).toHaveLength(1);
    });
  });

  // --- reconciliation ---------------------------------------------------------------------------

  describe('reconciling with payments', () => {
    const instructing = async () => {
      await addSeller();
      await makeAuto(10000n);
      await addOrder(ORDER_1, 20000n);
      payments.instructAnswer = 'unavailable';
      await run();
      payments.instructAnswer = { kind: 'accepted', transferExecutionId: TRANSFER };
      return only();
    };
    const lookupIs = (
      payout: Payout,
      state: 'none' | 'reserved' | 'sending' | 'executed' | 'refused' | 'abandoned' | 'failed',
      transferExecutionId: string | null = null,
    ) =>
      payments.transfers.set(payout.id, { instructionKey: payout.id, state, transferExecutionId });

    it('asks again by key, and makes the first call itself when payments never saw the key', async () => {
      const payout = await instructing();
      payments.instructed.length = 0;
      const summary = await reconcile();
      expect(summary).toMatchObject({ asked: 1, instructed: 1 });
      expect(payments.instructed.map((call) => call.instructionKey)).toEqual([payout.id]);
      expect(only().state).toBe('instructed');
    });

    it('re-checks the seller before it makes the first call itself, and unwinds if it fails', async () => {
      const payout = await instructing();
      payments.instructed.length = 0;
      access.eligibleSellers.delete(SELLER_A);
      const summary = await reconcile();
      expect(payments.instructed).toEqual([]);
      expect(payments.abandoned).toEqual([payout.id]);
      expect(summary).toMatchObject({ notSent: 1, instructed: 0 });
      expect(only()).toMatchObject({ state: 'not-sent', outcomeCode: 'payout-unwound' });
    });

    it('follows an executed transfer to PAID', async () => {
      const payout = await instructing();
      lookupIs(payout, 'executed', TRANSFER);
      expect(await reconcile()).toMatchObject({ paid: 1 });
      expect(only()).toMatchObject({ state: 'paid', transferExecutionId: TRANSFER });
    });

    it('marks a failed transfer FAILED and frees the seller orders', async () => {
      const payout = await instructing();
      lookupIs(payout, 'failed', TRANSFER);
      expect(await reconcile()).toMatchObject({ failed: 1 });
      expect(only()).toMatchObject({ state: 'failed', outcomeCode: 'transfer-failed' });
      expect((await payouts.position(market, SELLER_A)).itemAmounts.has(ORDER_1)).toBe(false);
    });

    it('closes a transfer payments refused as NOT_SENT', async () => {
      const payout = await instructing();
      lookupIs(payout, 'refused');
      expect(await reconcile()).toMatchObject({ notSent: 1 });
      expect(only()).toMatchObject({ state: 'not-sent', outcomeCode: 'transfer-refused' });
    });

    it('changes nothing when payments cannot answer', async () => {
      await instructing();
      payments.lookupUnavailable = true;
      expect(await reconcile()).toMatchObject({ asked: 0, waiting: 1 });
      expect(only().state).toBe('instructing');
    });

    it('fences after the send timeout, waits out the quarantine, then unwinds', async () => {
      const payout = await instructing();
      lookupIs(payout, 'none');
      // Inside the timeout (twice payments send lease: 120 s) nothing is fenced.
      clock.advance(Temporal.Duration.from({ seconds: 119 }));
      lookupIs(payout, 'reserved');
      expect(await reconcile()).toMatchObject({ fenced: 0, waiting: 1 });
      expect(payments.abandoned).toEqual([]);

      clock.advance(Temporal.Duration.from({ seconds: 2 }));
      payments.abandonAnswer = { kind: 'abandoned' };
      expect(await reconcile()).toMatchObject({ fenced: 1 });
      expect(payments.abandoned).toEqual([payout.id]);
      const fenced = only();
      expect(fenced.state).toBe('instructing');
      expect(fenced.abandonedAt).not.toBeNull();

      // The quarantine: asked again only 15 minutes after the fence.
      clock.advance(Temporal.Duration.from({ minutes: 14 }));
      lookupIs(payout, 'abandoned');
      expect(await reconcile()).toMatchObject({ waiting: 1 });
      expect(payments.abandoned).toHaveLength(1);

      clock.advance(Temporal.Duration.from({ minutes: 2 }));
      payments.abandonAnswer = { kind: 'still-abandoned' };
      expect(await reconcile()).toMatchObject({ notSent: 1 });
      expect(only()).toMatchObject({ state: 'not-sent', outcomeCode: 'payout-unwound' });
    });

    it('takes a transfer that turns out to have been sent when the fence is refused', async () => {
      const payout = await instructing();
      lookupIs(payout, 'sending');
      clock.advance(Temporal.Duration.from({ minutes: 5 }));
      payments.abandonAnswer = { kind: 'already-sent', transferExecutionId: TRANSFER };
      expect(await reconcile()).toMatchObject({ instructed: 1 });
      expect(only()).toMatchObject({ state: 'instructed', transferExecutionId: TRANSFER });
    });

    it('does not fence while the send is still in flight at payments', async () => {
      const payout = await instructing();
      lookupIs(payout, 'sending');
      clock.advance(Temporal.Duration.from({ minutes: 5 }));
      payments.abandonAnswer = { kind: 'in-flight' };
      expect(await reconcile()).toMatchObject({ fenced: 0, waiting: 1 });
      expect(only().abandonedAt).toBeNull();
    });
  });

  // --- the consumer of the transfer event ---------------------------------------------------------

  describe('the transfer-changed consumer', () => {
    const instructed = async () => {
      await addSeller();
      await makeAuto(10000n);
      await addOrder(ORDER_1, 20000n);
      await run();
      return only();
    };
    const apply = (transferExecutionId: unknown, n = 1) =>
      new ApplyTransferChange(gate, deps).execute(system, {
        delivery: delivery(n),
        transferExecutionId: transferExecutionId as string,
        sellerId: SELLER_A,
      });

    it('marks the payout PAID from what payments holds for its key, once per delivery', async () => {
      const payout = await instructed();
      payments.transfers.set(payout.id, {
        instructionKey: payout.id,
        state: 'executed',
        transferExecutionId: TRANSFER,
      });
      expect(await apply(TRANSFER)).toEqual(ok('paid'));
      expect(only().state).toBe('paid');
      expect(await apply(TRANSFER)).toEqual(ok('already-handled'));
    });

    it('marks it FAILED when the transfer failed', async () => {
      const payout = await instructed();
      payments.transfers.set(payout.id, {
        instructionKey: payout.id,
        state: 'failed',
        transferExecutionId: TRANSFER,
      });
      expect(await apply(TRANSFER)).toEqual(ok('failed'));
      expect(only()).toMatchObject({ state: 'failed', outcomeCode: 'transfer-failed' });
    });

    it('changes nothing for a transfer that has not finished', async () => {
      const payout = await instructed();
      payments.transfers.set(payout.id, {
        instructionKey: payout.id,
        state: 'sending',
        transferExecutionId: TRANSFER,
      });
      expect(await apply(TRANSFER)).toEqual(ok('unchanged'));
      expect(only().state).toBe('instructed');
    });

    it('asks for a retry when no payout owns the transfer yet, and refuses a bad id', async () => {
      await instructed();
      expect(await apply(id<'TransferExecution'>(0x999))).toEqual({
        ok: false,
        error: { code: 'commission-payouts.try-again' },
      });
      expect(await apply('nope')).toEqual({ ok: false, error: { code: 'validation.failed' } });
    });

    it('raises an alert instead of paying when payments holds another transfer for the key', async () => {
      const payout = await instructed();
      payments.transfers.set(payout.id, {
        instructionKey: payout.id,
        state: 'executed',
        transferExecutionId: id<'TransferExecution'>(0x777),
      });
      expect(await apply(TRANSFER)).toEqual(ok('alerted'));
      expect(only().state).toBe('instructed');
      expect(alerts().map((event) => event.payload)).toEqual([
        { sellerId: SELLER_A, reason: 'transfer-unmatched' },
      ]);
    });
  });

  // --- what admins see ----------------------------------------------------------------------------

  describe('the admin views', () => {
    const list = (input: Record<string, unknown>, context: CallContext = admin) =>
      new ListPayouts(gate, deps).execute(context, input);
    const view = (payoutId: unknown, context: CallContext = admin) =>
      new ViewPayout(gate, deps).execute(context, { payoutId });

    const several = async () => {
      for (let n = 0; n < 3; n += 1) {
        const sellerId = id<'Seller'>(0x60 + n);
        await addSeller(sellerId);
        await addOrder(id<'SellerOrder'>(0x600 + n), 20000n + BigInt(n), sellerId);
        names.names.set(sellerId, `Store ${n}`);
        clock.advance(Temporal.Duration.from({ seconds: 1 }));
      }
      await run();
    };

    it('lists newest first, in pages, with the store name', async () => {
      await several();
      const first = must(await list({ limit: 2 }));
      expect(first.payouts).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      expect(first.payouts[0]!.storeName).toMatch(/^Store /);
      const second = must(await list({ limit: 2, cursor: first.nextCursor }));
      expect(second.payouts).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      const ids = [...first.payouts, ...second.payouts].map((row) => row.payoutId);
      expect(new Set(ids).size).toBe(3);
    });

    it('filters by state in either spelling and refuses what it does not know', async () => {
      await several();
      expect(must(await list({ status: 'AWAITING_APPROVAL' })).payouts).toHaveLength(3);
      expect(must(await list({ status: 'awaiting-approval' })).payouts).toHaveLength(3);
      expect(must(await list({ status: 'paid' })).payouts).toHaveLength(0);
      expect(await list({ status: 'nonsense', cursor: 'x', limit: 0 })).toEqual({
        ok: false,
        error: {
          code: 'validation.failed',
          fields: [
            { path: 'status', code: 'value' },
            { path: 'limit', code: 'range' },
            { path: 'cursor', code: 'format' },
          ],
        },
      });
    });

    it('shows one payout with its items, the limits and the day total', async () => {
      await addSeller();
      await makeAuto(10000n);
      await addOrder(ORDER_1, 20000n);
      await run();
      const payout = only();
      const detail = must(await view(payout.id));
      expect(detail).toMatchObject({
        payoutId: payout.id,
        state: 'instructed',
        accountReadiness: 'ready',
        lastBankChangeAt: null,
        items: [{ sellerOrderId: ORDER_1, amount: { amountMinor: 20000n } }],
      });
      expect(detail.limits).toEqual({
        perTransfer: { amountMinor: 500_000n, currency: fixture.currency },
        todayTotal: { amountMinor: 20000n + 0n, currency: fixture.currency },
        dailyAlertLevel: { amountMinor: 2_000_000n, currency: fixture.currency },
        overDailyAlertLevel: false,
        transferAboveLimit: false,
      });
    });

    it('flags a transfer above the per-transfer limit and a day total over the alert level', async () => {
      await addSeller();
      await addOrder(ORDER_1, 600_000n);
      await run();
      const detail = must(await view(only().id));
      expect(detail.limits).toMatchObject({ transferAboveLimit: true, overDailyAlertLevel: false });
      deps = {
        ...deps,
        payoutPolicy: new FixedPayoutPolicy(
          { AU: 'Australia/Sydney', ZZ: 'Asia/Tokyo' },
          { AU: 'AUD', ZZ: 'JPY' },
          500_000n,
          100_000n,
        ),
      };
      expect(must(await view(only().id)).limits).toMatchObject({ overDailyAlertLevel: true });
    });

    it('answers the same for an unknown payout and a payout of another Market', async () => {
      await addSeller();
      await addOrder(ORDER_1, 20000n);
      await run();
      const unknown = await view(id<'Payout'>(0xbeef));
      expect(unknown).toEqual({
        ok: false,
        error: { code: 'commission-payouts.payout-not-found' },
      });
      expect(await view(only().id, actorOf(otherMarket, 'admin', null))).toEqual(unknown);
      expect(await view('bad')).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
    });

    it('refuses a seller on both admin reads', async () => {
      expect(await list({}, sellerCtx)).toEqual({ ok: false, error: { code: 'access.denied' } });
      expect(await view(id<'Payout'>(1), sellerCtx)).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
    });
  });

  // --- what sellers see ---------------------------------------------------------------------------

  describe('the seller views', () => {
    const next = (context: CallContext = sellerCtx) =>
      new ViewNextPayout(gate, deps).execute(context, undefined);
    const history = (input: Record<string, unknown> = {}, context: CallContext = sellerCtx) =>
      new ListOwnPayouts(gate, deps).execute(context, input);
    const held = (context: CallContext = sellerCtx) =>
      new ListOwnPayoutHolds(gate, deps).execute(context, undefined);

    it('estimates the next payout with its slot and amount before the slot', async () => {
      await addSeller();
      await addOrder(ORDER_1, 20000n);
      await stores.cursors.ensure(market, SELLER_A, T0);
      clock.set(T0);
      const view = must(await next());
      expect(view.zone).toBe(fixture.zone);
      expect(view.estimatedAmount).toEqual({ amountMinor: 20000n, currency: fixture.currency });
      expect(view.blockReason).toBeNull();
      expect(Temporal.Instant.compare(view.slotAt!, T0)).toBeGreaterThan(0);
    });

    it.each([
      ['below the minimum', 'below-minimum'],
      ['a missing zone', 'zone-missing'],
      ['a hold on the seller', 'payouts-paused'],
      ['a payout waiting for an admin', 'awaiting-approval'],
    ] as const)('says why nothing is coming: %s', async (_label, reason) => {
      await addSeller();
      await addOrder(ORDER_1, reason === 'below-minimum' ? fixture.minimum - 1n : 20000n);
      if (reason === 'zone-missing') access.zonesBySeller.delete(SELLER_A);
      if (reason === 'payouts-paused') await hold('seller-suspended', null);
      if (reason === 'awaiting-approval') await run();
      const view = must(await next());
      expect(view.blockReason).toBe(reason);
      if (reason === 'zone-missing') expect(view.slotAt).toBeNull();
    });

    it('remembers a reason the last evaluation found until the next one', async () => {
      await addSeller();
      await makeAuto(10000n);
      await addOrder(ORDER_1, 20000n);
      payments.ready.delete(SELLER_A);
      await run();
      expect(must(await next()).blockReason).toBe('account-not-ready');
    });

    it('lists only its own payouts, hides voided ones and says why a transfer did not go', async () => {
      await addSeller();
      await makeAuto(10000n);
      await addOrder(ORDER_1, 20000n);
      payments.instructAnswer = { kind: 'refused', code: 'payments.transfer.cooling-off' };
      await run();
      await addSeller(SELLER_B);
      await addOrder(id<'SellerOrder'>(0x221), 20000n, SELLER_B);
      await run();
      const own = must(await history());
      expect(own.payouts.map((row) => row.status).sort()).toEqual(['not-sent', 'paid']);
      expect(own.payouts.find((row) => row.status === 'not-sent')!.reason).toBe('cooling-off');
      expect(json(own)).not.toContain(SELLER_B);

      const otherSeller = must(await history({}, sellerBCtx));
      expect(otherSeller.payouts).toHaveLength(1);
      expect(otherSeller.payouts[0]!.status).toBe('awaiting-approval');

      // A voided payout never happened.
      const waiting = [...payouts.rows.values()].find((row) => row.sellerId === SELLER_B)!;
      payouts.rows.set(`${market.marketId}:${waiting.id}`, { ...waiting, state: 'voided' });
      expect(must(await history({}, sellerBCtx)).payouts).toEqual([]);
    });

    it('pages its history and refuses a bad page', async () => {
      await addSeller();
      await makeAuto(10000n);
      expect(must(await history({ limit: 1 })).nextCursor).toBeNull();
      expect(await history({ limit: 1000 })).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
    });

    it('shows money on hold per seller order, with the reason in the seller words and no admin note', async () => {
      await addSeller();
      await addOrder(ORDER_1, 20000n);
      await addOrder(ORDER_2, 8000n);
      const waitingOrder = id<'SellerOrder'>(0x203);
      ledger.set(SELLER_A, waitingOrder, 3000n);
      await stores.anchors.insertIfAbsent(market, {
        sellerOrderId: waitingOrder,
        orderId: id<'Order'>(0x101),
        sellerId: SELLER_A,
        deliveredAt: T0,
        source: 'carrier',
        holdDaysApplied: 7,
        eligibleAt: T0.add({ hours: 720 }),
        recordedAt: T0,
      });
      const undelivered = id<'SellerOrder'>(0x204);
      ledger.set(SELLER_A, undelivered, 1000n);
      await hold('refund-pending', ORDER_1);
      await hold('dispute', ORDER_2);
      const rows = must(await held());
      const byOrder = new Map(rows.map((row) => [row.sellerOrderId, row]));
      expect(byOrder.get(ORDER_1)).toMatchObject({ reason: 'refund-pending', availableFrom: null });
      expect(byOrder.get(ORDER_2)).toMatchObject({ reason: 'on-hold' });
      expect(byOrder.get(waitingOrder)).toMatchObject({ reason: 'holding-period' });
      expect(byOrder.get(waitingOrder)!.availableFrom!.toString()).toBe(
        T0.add({ hours: 720 }).toString(),
      );
      expect(byOrder.get(undelivered)).toMatchObject({ reason: 'awaiting-delivery' });
      const text = JSON.stringify(rows, (_k, v: unknown) =>
        typeof v === 'bigint' ? v.toString() : v,
      );
      expect(text).not.toContain('dispute');
      expect(text).not.toContain('admin-review');
      expect(text).not.toContain('src-');
    });

    it('refuses an admin on the seller reads', async () => {
      expect(await next(admin)).toEqual({ ok: false, error: { code: 'access.denied' } });
      expect(await history({}, admin)).toEqual({ ok: false, error: { code: 'access.denied' } });
      expect(await held(admin)).toEqual({ ok: false, error: { code: 'access.denied' } });
    });
  });

  it('spends no step-up proof in an acting-as session (Login as Seller)', async () => {
    const consumer = new AllowingStepUp();
    const acting = { actor: { kind: 'authenticated', actingAs: { sellerId: SELLER_A } } };
    expect(
      await spendStepUp({ stepUp: consumer }, acting as never, 'commission-payouts.payout.approve'),
    ).toEqual({
      ok: false,
      error: { code: 'access.denied' },
    });
    expect(consumer.spent).toEqual([]);
  });

  it('never lets two live payouts exist for one seller', async () => {
    await addSeller();
    await addOrder(ORDER_1, 20000n);
    await run();
    const [payout] = [...payouts.rows.values()];
    expect(() =>
      payouts.insert(market, { ...payout!, id: id<'Payout'>(0xabc) }, [
        { sellerOrderId: ORDER_2, amount: payout!.gross },
      ]),
    ).toThrow(/one live payout/);
  });

  it('records no step-up spend on a pure read or run', async () => {
    await addSeller();
    await addOrder(ORDER_1, 20000n);
    await run();
    expect(stores.stepUp).toBeInstanceOf(AllowingStepUp);
    expect(stores.stepUp.spent).toEqual([]);
  });
});
