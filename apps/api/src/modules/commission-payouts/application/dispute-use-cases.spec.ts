import { money, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { MemoryHolds } from '../../../../test/support/commission-payouts-fakes';
import {
  FakeDisputeSource,
  FakeOrderLookup,
  FakeSellerNames,
  MarketLedger,
  MemoryDisputes,
  RecordingCpOutbox,
  RecordingSecurityEvents,
} from '../../../../test/support/commission-payouts-dispute-fakes';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import type { EventDelivery } from '../../../platform/events/event-delivery';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { COMMISSION_PAYOUTS_AUDIT_ACTIONS } from '../domain/audit';
import type { LedgerEntry, LedgerKind } from '../domain/ledger';
import type { DisputeDependencies } from './dispute-dependencies';
import type { ProviderDispute } from './ports/dispute-source';
import { DecideDispute } from './use-cases/decide-dispute.use-case';
import { ListDisputes } from './use-cases/list-disputes.use-case';
import { ListOwnDisputes } from './use-cases/list-own-disputes.use-case';
import { SyncDispute } from './use-cases/sync-dispute.use-case';
import { ViewDispute } from './use-cases/view-dispute.use-case';

// Dispute effects (package 8b) in memory on both Market fixtures: the consumer holds and releases
// by the state payments returns, an admin decision writes its ledger row once, the seller reads
// only what D8 allows.

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
const ORDER = id<'Order'>(0x101);
const SO_A = id<'SellerOrder'>(0x201);
const SO_B = id<'SellerOrder'>(0x202);
const DISPUTE = id<'Dispute'>(0xd01);
const INTENT = 'pi_own';
const ACTIONS = new Set<string>(COMMISSION_PAYOUTS_AUDIT_ACTIONS.map((a) => a.action));
let deliveryNo = 0;
const delivery = (): EventDelivery => ({
  eventId: id<'event'>(0xe000 + ++deliveryNo),
  subscriber: 'commission-payouts.sync-dispute',
  attempt: 1,
});

class RecordingAudit implements AuditWriter {
  readonly entries: AuditEntry[] = [];
  record(_context: CallContext, entry: AuditEntry): Promise<void> {
    if (!ACTIONS.has(entry.action)) throw new Error(`audit: unknown action ${entry.action}`);
    this.entries.push(entry);
    return Promise.resolve();
  }
}

describe.each([['AU'], ['ZZ']] as const)('dispute effects in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
  const currency = markets.get(market.marketId).defaultCurrency;
  const clock = new FixedClock(T0);
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const actor = (
    mkt: typeof market,
    population: 'admin' | 'seller' | 'customer',
    sellerId: Id<'Seller'> | null,
  ) =>
    testCallContext(
      mkt,
      testAuthenticatedActor(mkt, {
        population,
        accountId: population === 'admin' ? ADMIN : id<'Account'>(0xa1),
        sessionId: id<'Session'>(0x61),
        sellerId,
      }),
      `disp-${population}-abcd`,
    );
  const admin = actor(market, 'admin', null);
  const sellerA = actor(market, 'seller', SELLER_A);
  const sellerB = actor(market, 'seller', SELLER_B);
  const customer = actor(market, 'customer', null);
  const system = testCallContext(market, 'system', 'disp-system-abcd');

  let ledger: MarketLedger;
  let disputes: MemoryDisputes;
  let holds: MemoryHolds;
  let source: FakeDisputeSource;
  let orders: FakeOrderLookup;
  let names: FakeSellerNames;
  let outbox: RecordingCpOutbox;
  let securityEvents: RecordingSecurityEvents;
  let audit: RecordingAudit;
  let deps: DisputeDependencies;

  const seed = (
    sellerOrderId: Id<'SellerOrder'>,
    sellerId: Id<'Seller'>,
    sale: bigint,
    commission: bigint,
    mkt = market,
  ) => {
    const row = (kind: LedgerKind, amount: bigint, n: number): LedgerEntry => ({
      id: id<'LedgerEntry'>(parseInt(sellerOrderId.slice(-3), 16) * 16 + n),
      sellerId,
      orderId: ORDER,
      sellerOrderId,
      orderLineId: kind === 'shipping' ? null : id<'OrderLine'>(0x300 + n),
      kind,
      amount: money(amount, currency),
      rateBps: null,
      baseAmount: null,
      sourceId: null,
      occurredAt: T0,
      recordedAt: T0,
    });
    return ledger.append(mkt, [row('sale', sale, 1), row('commission', commission, 2)]);
  };

  const provider = (state: Partial<ProviderDispute> & { version: number }): ProviderDispute => ({
    disputeId: DISPUTE,
    orderId: ORDER,
    providerDisputeId: 'dp_1',
    paymentIntentRef: INTENT,
    amount: money(2000n, currency),
    status: 'needs_response',
    reason: 'fraudulent',
    inquiry: false,
    closed: false,
    evidenceDueBy: T0.add({ hours: 24 * 7 }),
    fundsWithdrawn: false,
    fundsWithdrawnAt: null,
    fundsReinstated: false,
    fundsReinstatedAt: null,
    outcome: null,
    openedAt: T0,
    ...state,
  });
  const publish = (state: Partial<ProviderDispute> & { version: number }) =>
    source.disputes.set(DISPUTE, provider(state));
  const sync = (context = system, d = delivery()) =>
    new SyncDispute(gate, deps).execute(context, { delivery: d, disputeId: DISPUTE });
  const lost = (extra: Partial<ProviderDispute> = {}) =>
    publish({
      version: 3,
      status: 'lost',
      closed: true,
      outcome: 'lost',
      fundsWithdrawn: true,
      fundsWithdrawnAt: T0,
      ...extra,
    });
  const decide = (
    sellerOrderId: unknown,
    bearer: unknown,
    amountMinor?: unknown,
    reasonCode: unknown = 'other',
    context = admin,
  ) =>
    new DecideDispute(gate, deps).execute(context, {
      disputeId: DISPUTE,
      sellerOrderId,
      bearer,
      amountMinor,
      reasonCode,
    });
  const activeHolds = () => [...holds.rows.values()].filter((h) => h.releasedAt === null);

  beforeEach(async () => {
    ledger = new MarketLedger();
    disputes = new MemoryDisputes(ledger);
    holds = new MemoryHolds();
    source = new FakeDisputeSource();
    orders = new FakeOrderLookup();
    names = new FakeSellerNames();
    outbox = new RecordingCpOutbox();
    securityEvents = new RecordingSecurityEvents();
    audit = new RecordingAudit();
    orders.intents.set(ORDER, INTENT);
    names.names.set(SELLER_A, 'Alpha Store');
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      disputes,
      ledger,
      holds,
      source,
      orders,
      sellerNames: names,
      outbox,
      securityEvents,
      authorisation: { check: () => Promise.resolve({ allowed: true }) },
      audit,
      ids: new SequenceIdGenerator(clock),
      clock,
    };
    await seed(SO_A, SELLER_A, 1000n, 150n);
  });

  describe('the consumer', () => {
    it('holds the seller order while open, tells the seller once, and keeps the snapshot', async () => {
      publish({ version: 1, status: 'warning_needs_response', inquiry: true });
      expect(await sync()).toEqual(ok('synced'));
      expect(activeHolds()).toHaveLength(1);
      expect(activeHolds()[0]).toMatchObject({
        reason: 'dispute',
        origin: 'system',
        sourceRef: DISPUTE,
        sellerOrderId: SO_A,
        sellerId: SELLER_A,
      });
      expect(outbox.events.map((e) => [e.type, e.payload])).toEqual([
        [
          'commission-payouts.seller-order-disputed.v1',
          { sellerOrderId: SO_A, sellerId: SELLER_A, orderId: ORDER, disputeId: DISPUTE },
        ],
      ]);
      expect(disputes.cases.get(`${market.marketId}:${DISPUTE}`)).toMatchObject({
        bucket: 'needs-response',
        inquiry: true,
        lastSyncedVersion: 1,
      });
      // The inquiry becomes a chargeback: the same hold, no second notice.
      publish({ version: 2, status: 'needs_response', fundsWithdrawn: true, fundsWithdrawnAt: T0 });
      await sync();
      expect(activeHolds()).toHaveLength(1);
      expect(outbox.events).toHaveLength(1);
      expect(ledger.all(market).map((r) => r.kind)).toEqual(['sale', 'commission']);
    });

    it('releases the holds when the chargeback is won, by the system', async () => {
      publish({ version: 1 });
      await sync();
      publish({ version: 2, status: 'won', closed: true, outcome: 'won' });
      await sync();
      expect(activeHolds()).toHaveLength(0);
      const hold = [...holds.rows.values()][0]!;
      expect(hold).toMatchObject({ releasedBy: null, releaseReason: 'resolved' });
      expect(disputes.cases.get(`${market.marketId}:${DISPUTE}`)).toMatchObject({
        bucket: 'won',
        closedAt: T0,
      });
      expect(audit.entries.map((e) => e.action)).toEqual([
        'commission-payouts.payout-hold.place',
        'commission-payouts.payout-hold.release',
      ]);
    });

    it('releases a closed inquiry', async () => {
      publish({ version: 1, status: 'warning_needs_response', inquiry: true });
      await sync();
      publish({ version: 2, status: 'warning_closed', inquiry: true, closed: true });
      await sync();
      expect(activeHolds()).toHaveLength(0);
      expect(disputes.cases.get(`${market.marketId}:${DISPUTE}`)?.bucket).toBe('closed');
    });

    it('keeps the hold on a lost chargeback until every seller order is decided', async () => {
      await seed(SO_B, SELLER_B, 500n, 75n);
      publish({ version: 1 });
      await sync();
      expect(activeHolds()).toHaveLength(2);
      lost();
      await sync();
      expect(activeHolds()).toHaveLength(2);
      expect(disputes.cases.get(`${market.marketId}:${DISPUTE}`)?.bucket).toBe('decision-needed');
      expect((await decide(SO_A, 'platform')).ok).toBe(true);
      // The holds go together, once every seller order has a decision.
      expect(activeHolds()).toHaveLength(2);
      const last = await decide(SO_B, 'seller', '100');
      expect(last).toMatchObject({ ok: true, value: { holdsReleased: true, bucket: 'closed' } });
      expect(activeHolds()).toHaveLength(0);
      expect(outbox.events).toHaveLength(2);
    });

    it('holds nothing when the order has no ledger rows yet, and still keeps the case', async () => {
      ledger.rows.clear();
      publish({ version: 1 });
      expect(await sync()).toEqual(ok('synced'));
      expect(holds.rows.size).toBe(0);
      expect(outbox.events).toHaveLength(0);
      expect(disputes.cases.size).toBe(1);
    });

    it('is idempotent: a redelivery and an older read change nothing', async () => {
      publish({ version: 2 });
      const d = delivery();
      expect(await sync(system, d)).toEqual(ok('synced'));
      expect(await sync(system, d)).toEqual(ok('already-handled'));
      publish({ version: 1, status: 'under_review' });
      expect(await sync()).toEqual(ok('stale'));
      expect(disputes.cases.get(`${market.marketId}:${DISPUTE}`)).toMatchObject({
        lastSyncedVersion: 2,
        status: 'needs_response',
      });
      // A newer delivery of the same state again: still one hold and one notice.
      expect(await sync()).toEqual(ok('stale'));
      publish({ version: 2 });
      await sync();
      expect(holds.rows.size).toBe(1);
      expect(outbox.events).toHaveLength(1);
    });

    it('parks a PaymentIntent mismatch and an unknown order: alert, no hold, no snapshot', async () => {
      publish({ version: 1, paymentIntentRef: 'pi_other' });
      expect(await sync()).toEqual(ok('parked'));
      orders.intents.clear();
      expect(await sync()).toEqual(ok('parked'));
      expect(holds.rows.size).toBe(0);
      expect(disputes.cases.size).toBe(0);
      expect(securityEvents.events.map((e) => e.payload)).toEqual([
        { disputeId: DISPUTE, reason: 'payment-intent-mismatch' },
        { disputeId: DISPUTE, reason: 'unknown-order' },
      ]);
    });

    it('parks a read that names another order than the stored case: alert, nothing refreshed', async () => {
      publish({ version: 1 });
      await sync();
      const before = disputes.cases.get(`${market.marketId}:${DISPUTE}`);
      const otherOrder = id<'Order'>(0x1ff);
      orders.intents.set(otherOrder, INTENT);
      publish({ version: 2, orderId: otherOrder, status: 'under_review' });
      expect(await sync()).toEqual(ok('parked'));
      expect(disputes.cases.get(`${market.marketId}:${DISPUTE}`)).toEqual(before);
      expect(securityEvents.events.map((e) => e.payload)).toEqual([
        { disputeId: DISPUTE, reason: 'order-changed' },
      ]);
    });

    it('retries when a read is unavailable, and finishes when payments does not know the dispute', async () => {
      source.unavailable = true;
      expect(await sync()).toMatchObject({
        ok: false,
        error: { code: 'commission-payouts.try-again' },
      });
      source.unavailable = false;
      orders.unavailable = true;
      publish({ version: 1 });
      expect(await sync()).toMatchObject({
        ok: false,
        error: { code: 'commission-payouts.try-again' },
      });
      orders.unavailable = false;
      source.disputes.clear();
      expect(await sync()).toEqual(ok('unknown-dispute'));
      expect(
        await new SyncDispute(gate, deps).execute(system, { delivery: delivery(), disputeId: 'x' }),
      ).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
    });

    it('refuses every caller but the system', async () => {
      publish({ version: 1 });
      for (const context of [admin, sellerA, customer]) {
        expect(await sync(context)).toMatchObject({ ok: false, error: { code: 'access.denied' } });
      }
    });

    it('keeps the Markets apart', async () => {
      publish({ version: 1 });
      await seed(id<'SellerOrder'>(0x2ff), SELLER_B, 900n, 90n, other);
      await sync();
      expect(disputes.cases.has(`${other.marketId}:${DISPUTE}`)).toBe(false);
      const foreign = actor(other, 'admin', null);
      expect(
        await new ViewDispute(gate, deps).execute(foreign, { disputeId: DISPUTE }),
      ).toMatchObject({ ok: false, error: { code: 'commission-payouts.dispute-not-found' } });
      expect(
        (await new ListDisputes(gate, deps).execute(foreign, {})).ok &&
          (await new ListDisputes(gate, deps).execute(foreign, {})),
      ).toMatchObject({ value: { disputes: [] } });
    });
  });

  describe('the admin decision', () => {
    beforeEach(async () => {
      publish({ version: 1 });
      await sync();
    });

    it('refuses until the chargeback is lost', async () => {
      expect(await decide(SO_A, 'platform')).toMatchObject({
        ok: false,
        error: { code: 'commission-payouts.dispute.not-decidable' },
      });
      publish({ version: 2, status: 'won', closed: true, outcome: 'won' });
      await sync();
      expect(await decide(SO_A, 'seller', '10')).toMatchObject({
        ok: false,
        error: { code: 'commission-payouts.dispute.not-decidable' },
      });
    });

    it('lets the platform bear a lost chargeback: no ledger row, holds released', async () => {
      lost();
      await sync();
      const result = await decide(SO_A, 'platform', undefined, 'card-fraud-not-seller');
      expect(result).toMatchObject({
        ok: true,
        value: { bearer: 'platform', amount: null, holdsReleased: true, bucket: 'closed' },
      });
      expect(ledger.all(market).map((r) => r.kind)).toEqual(['sale', 'commission']);
      expect(activeHolds()).toHaveLength(0);
      expect(audit.entries.map((e) => e.action)).toContain('commission-payouts.dispute.decide');
      expect(await decide(SO_A, 'platform')).toMatchObject({
        ok: false,
        error: { code: 'commission-payouts.dispute.already-decided' },
      });
    });

    it('recovers from the seller up to its unreversed share, once, as a dispute-debit', async () => {
      lost();
      await sync();
      // sale 1000 - commission 150 = 850 is the cap (commission is not reversed).
      for (const bad of ['0', '851', '-1', '1.5', 'abc', 100]) {
        expect(await decide(SO_A, 'seller', bad)).toMatchObject({ ok: false });
      }
      expect(await decide(SO_A, 'seller', '850')).toMatchObject({
        ok: true,
        value: { bearer: 'seller', amount: { amountMinor: 850n, currency } },
      });
      const debit = ledger.all(market).find((r) => r.kind === 'dispute-debit')!;
      expect(debit).toMatchObject({ sourceId: DISPUTE, sellerOrderId: SO_A, occurredAt: T0 });
      expect(debit.amount).toEqual(money(850n, currency));
      expect(
        audit.entries.find((e) => e.action === 'commission-payouts.dispute.decide'),
      ).toMatchObject({
        action: 'commission-payouts.dispute.decide',
        before: { bearer: null, capAmount: money(850n, currency) },
        after: { bearer: 'seller', amount: money(850n, currency), reversal: false },
      });
      expect(await decide(SO_A, 'seller', '10')).toMatchObject({
        ok: false,
        error: { code: 'commission-payouts.dispute.already-decided' },
      });
    });

    it('refuses an amount over the cap as out of range', async () => {
      lost();
      await sync();
      expect(await decide(SO_A, 'seller', '851')).toMatchObject({
        ok: false,
        error: { code: 'commission-payouts.dispute.amount-out-of-range' },
      });
      const r = await decide(SO_A, 'seller', '99999');
      expect(r).toMatchObject({
        ok: false,
        error: { code: 'commission-payouts.dispute.amount-out-of-range' },
      });
    });

    it.each([
      ['the whole cap', '850', true],
      ['one under the cap', '849', true],
      ['one minor unit', '1', true],
      ['one over the cap', '851', false],
    ] as const)('takes %s (cap 850): accepted is %s', async (_name, amount, accepted) => {
      lost();
      await sync();
      expect(await decide(SO_A, 'seller', amount)).toMatchObject(
        accepted
          ? { ok: true, value: { amount: { amountMinor: BigInt(amount), currency } } }
          : { ok: false, error: { code: 'commission-payouts.dispute.amount-out-of-range' } },
      );
    });

    it('refuses a seller bearer on a seller order whose cap is zero, and lets the platform bear it', async () => {
      // Sale 100, commission 100: nothing left to recover.
      await seed(SO_B, SELLER_B, 100n, 100n);
      lost();
      await sync();
      expect(await decide(SO_B, 'seller', '1')).toMatchObject({
        ok: false,
        error: { code: 'commission-payouts.dispute.amount-out-of-range' },
      });
      expect(ledger.all(market).filter((r) => r.kind === 'dispute-debit')).toHaveLength(0);
      expect(await decide(SO_B, 'platform')).toMatchObject({ ok: true });
    });

    it('reverses a partial seller decision by exactly that amount, and the cap is whole again', async () => {
      lost();
      await sync();
      await decide(SO_A, 'seller', '300');
      lost({ version: 4, fundsReinstated: true, fundsReinstatedAt: T0.add({ hours: 48 }) });
      await sync();
      expect(await decide(SO_A, 'platform')).toMatchObject({ ok: true, value: { reversal: true } });
      const rows = ledger.all(market).filter((r) => r.kind.startsWith('dispute-'));
      expect(rows.map((r) => [r.kind, r.amount.amount])).toEqual([
        ['dispute-debit', 300n],
        ['dispute-reinstate', 300n],
      ]);
    });

    it('reverses a seller decision only in needs-review, once, as a dispute-reinstate', async () => {
      lost();
      await sync();
      await decide(SO_A, 'seller', '400');
      // Not reinstated yet: a second decision is refused.
      expect(await decide(SO_A, 'platform')).toMatchObject({
        ok: false,
        error: { code: 'commission-payouts.dispute.already-decided' },
      });
      lost({ version: 4, fundsReinstated: true, fundsReinstatedAt: T0.add({ hours: 48 }) });
      await sync();
      expect(disputes.cases.get(`${market.marketId}:${DISPUTE}`)?.bucket).toBe('decision-needed');
      // The seller may not be charged again, nor the same decision repeated.
      expect(await decide(SO_A, 'seller', '10')).toMatchObject({
        ok: false,
        error: { code: 'commission-payouts.dispute.already-decided' },
      });
      expect(await decide(SO_A, 'platform', undefined, 'other')).toMatchObject({
        ok: true,
        value: { bearer: 'platform', reversal: true, amount: null, bucket: 'closed' },
      });
      const credit = ledger.all(market).find((r) => r.kind === 'dispute-reinstate')!;
      expect(credit).toMatchObject({ sourceId: DISPUTE, sellerOrderId: SO_A });
      expect(credit.amount).toEqual(money(400n, currency));
      expect(await decide(SO_A, 'platform')).toMatchObject({
        ok: false,
        error: { code: 'commission-payouts.dispute.already-decided' },
      });
    });

    it('refuses a bad request, a foreign seller order, an unknown dispute, and non-admins', async () => {
      lost();
      await sync();
      expect(await decide('nope', 'maybe', undefined, 'x')).toMatchObject({
        ok: false,
        error: {
          code: 'validation.failed',
          fields: [
            { path: 'sellerOrderId', code: 'format' },
            { path: 'bearer', code: 'format' },
            { path: 'reasonCode', code: 'format' },
          ],
        },
      });
      expect(await decide(SO_A, 'platform', '5')).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
      expect(await decide(id<'SellerOrder'>(0x2aa), 'platform')).toMatchObject({
        ok: false,
        error: { code: 'commission-payouts.seller-order-not-found' },
      });
      const unknown = await new DecideDispute(gate, deps).execute(admin, {
        disputeId: id<'Dispute'>(0xdff),
        sellerOrderId: SO_A,
        bearer: 'platform',
        reasonCode: 'other',
      });
      expect(unknown).toMatchObject({
        ok: false,
        error: { code: 'commission-payouts.dispute-not-found' },
      });
      for (const context of [sellerA, customer, system]) {
        expect(await decide(SO_A, 'platform', undefined, 'other', context)).toMatchObject({
          ok: false,
          error: { code: 'access.denied' },
        });
      }
    });
  });

  describe('the reads', () => {
    beforeEach(async () => {
      await seed(SO_B, SELLER_B, 500n, 75n);
      publish({ version: 1 });
      await sync();
    });

    it('lists by bucket with counts, store names and the money state', async () => {
      const list = await new ListDisputes(gate, deps).execute(admin, {});
      expect(list).toMatchObject({
        ok: true,
        value: {
          counts: {
            'needs-response': 1,
            'decision-needed': 0,
            'under-review': 0,
            won: 0,
            closed: 0,
          },
          nextCursor: null,
        },
      });
      expect(list.ok && list.value.disputes[0]).toMatchObject({
        disputeId: DISPUTE,
        orderId: ORDER,
        reason: 'fraudulent',
        moneyState: 'none',
        bucket: 'needs-response',
        amount: { amountMinor: 2000n, currency },
      });
      expect(list.ok && list.value.disputes[0]!.sellers).toEqual([
        { sellerId: SELLER_A, storeName: 'Alpha Store' },
        { sellerId: SELLER_B, storeName: null },
      ]);
      const empty = await new ListDisputes(gate, deps).execute(admin, { filter: 'won' });
      expect(empty).toMatchObject({ ok: true, value: { disputes: [] } });
      names.unavailable = true;
      expect(await new ListDisputes(gate, deps).execute(admin, {})).toMatchObject({ ok: true });
    });

    it('refuses a bad filter, cursor or limit, and every caller but an admin', async () => {
      expect(
        await new ListDisputes(gate, deps).execute(admin, {
          filter: 'x',
          cursor: 'y',
          limit: 0,
        }),
      ).toMatchObject({
        ok: false,
        error: {
          code: 'validation.failed',
          fields: [
            { path: 'filter', code: 'format' },
            { path: 'cursor', code: 'format' },
            { path: 'limit', code: 'range' },
          ],
        },
      });
      for (const context of [sellerA, customer, system]) {
        expect(await new ListDisputes(gate, deps).execute(context, {})).toMatchObject({
          ok: false,
          error: { code: 'access.denied' },
        });
      }
    });

    it('pages by cursor', async () => {
      publish({ version: 1 });
      const second = id<'Dispute'>(0xd02);
      source.disputes.set(second, {
        ...provider({ version: 1 }),
        disputeId: second,
        openedAt: T0.add({ hours: 1 }),
      });
      await new SyncDispute(gate, deps).execute(system, {
        delivery: delivery(),
        disputeId: second,
      });
      const first = await new ListDisputes(gate, deps).execute(admin, { limit: 1 });
      expect(first.ok && first.value.disputes.map((d) => d.disputeId)).toEqual([second]);
      const cursor = first.ok ? first.value.nextCursor : null;
      expect(cursor).not.toBeNull();
      const next = await new ListDisputes(gate, deps).execute(admin, { limit: 1, cursor });
      expect(next.ok && next.value.disputes.map((d) => d.disputeId)).toEqual([DISPUTE]);
      expect(next.ok && next.value.nextCursor).toBeNull();
    });

    it('shows the case with each seller order, cap, hold, decision and timeline', async () => {
      lost();
      await sync();
      await decide(SO_A, 'seller', '300');
      const view = await new ViewDispute(gate, deps).execute(admin, { disputeId: DISPUTE });
      expect(view).toMatchObject({
        ok: true,
        value: {
          providerDisputeId: 'dp_1',
          bucket: 'decision-needed',
          needsReview: false,
          outcome: 'lost',
        },
      });
      const rows = view.ok ? view.value.sellerOrders : [];
      const a = rows.find((r) => r.sellerOrderId === SO_A)!;
      const b = rows.find((r) => r.sellerOrderId === SO_B)!;
      expect(a).toMatchObject({
        storeName: 'Alpha Store',
        sellerShare: { amountMinor: 850n },
        recoverableCap: { amountMinor: 550n },
        holdActive: true,
        decision: 'not-allowed',
        decided: { bearer: 'seller', amount: { amountMinor: 300n } },
      });
      expect(b).toMatchObject({
        sellerShare: { amountMinor: 425n },
        recoverableCap: { amountMinor: 425n },
        holdActive: true,
        decision: 'allowed',
        decided: null,
      });
      const kinds = view.ok ? view.value.timeline.map((t) => t.kind) : [];
      expect(kinds).toEqual(['opened', 'funds-withdrawn', 'closed', 'decided']);
      expect(await new ViewDispute(gate, deps).execute(admin, { disputeId: 'nope' })).toMatchObject(
        { ok: false, error: { code: 'validation.failed' } },
      );
      expect(
        await new ViewDispute(gate, deps).execute(sellerA, { disputeId: DISPUTE }),
      ).toMatchObject({ ok: false, error: { code: 'access.denied' } });
    });

    it('shows the held banner but not the repaid amount to a member without earnings.view', async () => {
      const asked: string[] = [];
      deps = {
        ...deps,
        authorisation: {
          check: (_context, declaration) => {
            asked.push(JSON.stringify(declaration.rule));
            return Promise.resolve({
              allowed: false,
              denial: { code: 'access.denied' },
            } as never);
          },
        },
      };
      lost();
      await sync();
      await decide(SO_A, 'seller', '300');
      await decide(SO_B, 'platform');
      expect(await new ListOwnDisputes(gate, deps).execute(sellerA, undefined)).toEqual(
        ok([
          { sellerOrderId: SO_A, orderId: ORDER, since: T0, open: false, recoveredAmount: null },
        ]),
      );
      expect(asked).toEqual([
        JSON.stringify({ kind: 'permissions', allOf: ['commission-payouts.earnings.view'] }),
      ]);
      // A failing check is "no" as well.
      deps = {
        ...deps,
        authorisation: { check: () => Promise.reject(new Error('identity down')) },
      };
      expect(await new ListOwnDisputes(gate, deps).execute(sellerA, undefined)).toMatchObject({
        ok: true,
        value: [{ recoveredAmount: null }],
      });
    });

    it('tells a seller only its own seller order, with no reason and no provider data', async () => {
      const mine = await new ListOwnDisputes(gate, deps).execute(sellerA, undefined);
      expect(mine).toEqual(
        ok([{ sellerOrderId: SO_A, orderId: ORDER, since: T0, open: true, recoveredAmount: null }]),
      );
      lost();
      await sync();
      await decide(SO_A, 'seller', '300');
      await decide(SO_B, 'platform');
      const after = await new ListOwnDisputes(gate, deps).execute(sellerA, undefined);
      expect(after).toEqual(
        ok([
          {
            sellerOrderId: SO_A,
            orderId: ORDER,
            since: T0,
            open: false,
            recoveredAmount: { amountMinor: 300n, currency },
          },
        ]),
      );
      const theirs = await new ListOwnDisputes(gate, deps).execute(sellerB, undefined);
      expect(theirs).toEqual(
        ok([
          { sellerOrderId: SO_B, orderId: ORDER, since: T0, open: false, recoveredAmount: null },
        ]),
      );
      const text = JSON.stringify(after, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}` : v));
      expect(text).not.toMatch(/fraudulent|dp_1|evidence|reason/i);
      for (const context of [admin, customer, system]) {
        expect(await new ListOwnDisputes(gate, deps).execute(context, undefined)).toMatchObject({
          ok: false,
        });
      }
    });
  });
});
