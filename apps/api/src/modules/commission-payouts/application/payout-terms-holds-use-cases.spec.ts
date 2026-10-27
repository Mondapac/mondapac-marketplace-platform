import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { payoutStores } from '../../../../test/support/commission-payouts-fakes';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import type { EventDelivery } from '../../../platform/events/event-delivery';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { COMMISSION_PAYOUTS_AUDIT_ACTIONS } from '../domain/audit';
import { ConfigCommissionPolicy } from '../infrastructure/config-commission-policy';
import { ConfigPayoutTermsPolicy } from '../infrastructure/config-payout-terms-policy';
import type { CommissionPayoutsDependencies } from './commission-payouts-dependencies';
import type { LedgerRepository } from './ports/ledger.repository';
import type { SellerRateRepository } from './ports/seller-rate.repository';
import { ClearSellerPayoutTerms } from './use-cases/clear-seller-payout-terms.use-case';
import { ListSellerPayoutHolds } from './use-cases/list-seller-payout-holds.use-case';
import { NoteSellerReinstated } from './use-cases/note-seller-reinstated.use-case';
import { PlacePayoutHold } from './use-cases/place-payout-hold.use-case';
import { PlaceSellerSuspendedHold } from './use-cases/place-seller-suspended-hold.use-case';
import { RecordSellerOrderDelivered } from './use-cases/record-seller-order-delivered.use-case';
import { ReleasePayoutHold } from './use-cases/release-payout-hold.use-case';
import { SetSellerPayoutTerms } from './use-cases/set-seller-payout-terms.use-case';
import { ViewSellerPayoutTerms } from './use-cases/view-seller-payout-terms.use-case';

// Package 6b on both Market fixtures (AU: AUD, hold 7/14 days; ZZ: JPY, hold 10/21 days): the
// payout terms override with its version, the holds an admin places and releases, the system hold
// from identity's suspension event, and the eligibility anchor.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-14T10:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const SELLER_A = id<'Seller'>(0x51);
const SELLER_B = id<'Seller'>(0x52);
const GHOST = id<'Seller'>(0x5f);
const ADMIN = id<'Account'>(0xad);
const ORDER = id<'Order'>(0x101);
const SELLER_ORDER = id<'SellerOrder'>(0x201);
const OTHER_ORDER = id<'SellerOrder'>(0x202);
const DECISION = id<'SellerAccessDecision'>(0xd1);
const ACTIONS = new Set<string>(COMMISSION_PAYOUTS_AUDIT_ACTIONS.map((a) => a.action));
const delivery = (n: number, subscriber: string): EventDelivery => ({
  eventId: id<'event'>(0xe00 + n),
  subscriber,
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

/** Only what package 6b reads of the ledger: which seller a seller order belongs to. */
const ledgerOf = (owners: ReadonlyMap<string, Id<'Seller'>>): LedgerRepository =>
  ({
    sellerOfSellerOrder: (_m: MarketContext, sellerOrderId: Id<'SellerOrder'>) =>
      Promise.resolve(owners.get(sellerOrderId) ?? null),
  }) as unknown as LedgerRepository;

describe.each([['AU'], ['ZZ']] as const)('payout terms and holds in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const config = markets.get(market.marketId);
  const marketTerms = config.commissionPayouts!.payoutTerms!;
  const clock = new FixedClock(T0);
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const actor = (population: 'admin' | 'seller', sellerId: Id<'Seller'> | null) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: population === 'admin' ? ADMIN : id<'Account'>(0xa1),
        sessionId: id<'Session'>(0x61),
        sellerId,
      }),
      `cp-${population}-abcd`,
    );
  const admin = actor('admin', null);
  const sellerA = actor('seller', SELLER_A);
  const system = testCallContext(market, 'system', 'cp-system-abcd');

  let audit: RecordingAudit;
  let stores: ReturnType<typeof payoutStores>;
  let policyTerms: ConfigPayoutTermsPolicy | { marketTerms: () => null };
  let deps: CommissionPayoutsDependencies;
  const build = (policy: ConfigPayoutTermsPolicy | { marketTerms: () => null }) => {
    policyTerms = policy;
    stores = payoutStores(policy);
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      rates: {} as SellerRateRepository,
      ledger: ledgerOf(new Map([[SELLER_ORDER, SELLER_A]])),
      policy: new ConfigCommissionPolicy(markets),
      ...stores,
      sellers: {
        exists: (_c: CallContext, sellerId: Id<'Seller'>) =>
          Promise.resolve(sellerId === SELLER_A || sellerId === SELLER_B),
      },
      audit,
      ids: new SequenceIdGenerator(clock),
      clock,
    };
  };

  beforeEach(() => {
    audit = new RecordingAudit();
    build(new ConfigPayoutTermsPolicy(markets));
  });

  const view = (sellerId: unknown, context = admin) =>
    new ViewSellerPayoutTerms(gate, deps).execute(context, { sellerId });
  const set = (
    sellerId: unknown,
    terms: unknown,
    expectedVersion: unknown = null,
    context = admin,
  ) => new SetSellerPayoutTerms(gate, deps).execute(context, { sellerId, terms, expectedVersion });
  const clear = (sellerId: unknown, expectedVersion: unknown, context = admin) =>
    new ClearSellerPayoutTerms(gate, deps).execute(context, { sellerId, expectedVersion });

  describe('payout terms', () => {
    it('answers the Market terms for a seller without an override', async () => {
      const result = await view(SELLER_A);
      expect(result).toMatchObject({
        ok: true,
        value: { sellerId: SELLER_A, source: 'market', override: null, version: null },
      });
      if (!result.ok) throw new Error('unreachable');
      expect(result.value.effective).toMatchObject({
        holdDaysCarrier: marketTerms.holdDaysCarrier,
        holdDaysSellerClick: marketTerms.holdDaysSellerClick,
        approvalMode: marketTerms.approvalMode,
        firstPayoutManual: marketTerms.firstPayoutManual,
      });
    });

    it('sets an override over the Market terms, bumps the version and audits before and after', async () => {
      const first = await set(SELLER_A, { holdDaysCarrier: 9, minimumMinor: 7000 });
      expect(first).toMatchObject({ ok: true, value: { source: 'seller', version: 1 } });
      if (!first.ok) throw new Error('unreachable');
      expect(first.value.effective).toMatchObject({
        holdDaysCarrier: 9,
        holdDaysSellerClick: marketTerms.holdDaysSellerClick,
        minimumMinor: 7000n,
      });
      const second = await set(SELLER_A, { holdDaysCarrier: 12 }, 1);
      expect(second).toMatchObject({ ok: true, value: { version: 2 } });
      expect(audit.entries.map((e) => [e.action, e.targetId, e.before, e.after])).toMatchObject([
        [
          'commission-payouts.payout-terms.set',
          SELLER_A,
          { holdDaysCarrier: null, version: null },
          { holdDaysCarrier: 9, minimumMinor: 7000, version: 1 },
        ],
        [
          'commission-payouts.payout-terms.set',
          SELLER_A,
          { holdDaysCarrier: 9, version: 1 },
          { holdDaysCarrier: 12, minimumMinor: null, version: 2 },
        ],
      ]);
      expect(stores.termsOverrides.rows.size).toBe(1);
    });

    it('refuses a stale or missing version and leaves the override alone', async () => {
      await set(SELLER_A, { holdDaysCarrier: 9 });
      const conflict = err({ code: 'commission-payouts.version-conflict' });
      expect(await set(SELLER_A, { holdDaysCarrier: 10 }, null)).toEqual(conflict);
      expect(await set(SELLER_A, { holdDaysCarrier: 10 }, 5)).toEqual(conflict);
      expect(await clear(SELLER_A, 5)).toEqual(conflict);
      expect(await set(SELLER_B, { holdDaysCarrier: 10 }, 1)).toEqual(conflict);
      expect(stores.termsOverrides.rows.get(`${market.marketId}:${SELLER_A}`)?.version).toBe(1);
      expect(audit.entries).toHaveLength(1);
    });

    it('refuses hold days outside the 7 to 60 bounds and malformed input', async () => {
      for (const days of [6, 61, 0, -1, 7.5, '9']) {
        expect(await set(SELLER_A, { holdDaysCarrier: days })).toMatchObject({
          ok: false,
          error: { code: 'validation.failed' },
        });
        expect(await set(SELLER_A, { holdDaysSellerClick: days })).toMatchObject({
          ok: false,
          error: { code: 'validation.failed' },
        });
      }
      expect(await set(SELLER_A, { holdDaysCarrier: 7 })).toMatchObject({ ok: true });
      expect(await set(SELLER_A, { holdDaysCarrier: 60 }, 1)).toMatchObject({ ok: true });
      expect(await set('nope', {}, 'x')).toMatchObject({
        ok: false,
        error: {
          code: 'validation.failed',
          fields: expect.arrayContaining([
            { path: 'sellerId', code: 'format' },
            { path: 'expectedVersion', code: 'range' },
          ]) as unknown,
        },
      });
      expect(await set(SELLER_A, { unknownField: 1 }, 2)).toMatchObject({ ok: false });
    });

    it('removes the override back to the Market terms, audited; nothing to remove is terms-not-set', async () => {
      expect(await clear(SELLER_A, 1)).toEqual(err({ code: 'commission-payouts.terms-not-set' }));
      await set(SELLER_A, { holdDaysCarrier: 9 });
      expect(await clear(SELLER_A, 1)).toMatchObject({
        ok: true,
        value: { source: 'market', override: null, version: null },
      });
      expect(stores.termsOverrides.rows.size).toBe(0);
      expect(audit.entries.at(-1)).toMatchObject({
        action: 'commission-payouts.payout-terms.clear',
        before: { holdDaysCarrier: 9, version: 1 },
        after: { version: null },
      });
    });

    it('finds only a seller of the context Market: unknown is byte-identical not-found', async () => {
      const notFound = err({ code: 'commission-payouts.seller-not-found' });
      expect(await view(GHOST)).toEqual(notFound);
      expect(await set(GHOST, { holdDaysCarrier: 9 })).toEqual(notFound);
      expect(await clear(GHOST, 1)).toEqual(notFound);
      expect(audit.entries).toEqual([]);
    });

    it('refuses every caller but an admin', async () => {
      for (const other of [sellerA, system]) {
        expect(await view(SELLER_A, other)).toMatchObject({ ok: false });
        expect(await set(SELLER_A, {}, null, other)).toMatchObject({ ok: false });
        expect(await clear(SELLER_A, 1, other)).toMatchObject({ ok: false });
      }
      expect(await view(SELLER_A, sellerA)).toEqual(err({ code: 'access.denied' }));
      expect(stores.termsOverrides.rows.size).toBe(0);
    });

    it('fails closed: a Market without terms, or a stored override out of bounds, is unavailable', async () => {
      build({ marketTerms: () => null });
      const unavailable = err({ code: 'commission-payouts.terms-unavailable' });
      expect(await view(SELLER_A)).toEqual(unavailable);
      // An err result commits nothing in the real unit of work (the fake does not roll back).
      expect(await set(SELLER_A, { holdDaysCarrier: 9 })).toEqual(unavailable);
      expect(audit.entries).toEqual([]);

      build(new ConfigPayoutTermsPolicy(markets));
      stores.termsOverrides.rows.set(`${market.marketId}:${SELLER_A}`, {
        sellerId: SELLER_A,
        override: {
          weekdays: null,
          localTime: null,
          holdDaysCarrier: 3,
          holdDaysSellerClick: null,
          minimumMinor: null,
          approvalMode: null,
        },
        version: 1,
        updatedAt: T0,
        updatedBy: ADMIN,
      });
      expect(await view(SELLER_A)).toEqual(unavailable);
    });
  });

  describe('holds placed by an admin', () => {
    const place = (input: Record<string, unknown>, context = admin) =>
      new PlacePayoutHold(gate, deps).execute(context, input as never);
    const release = (holdId: unknown, reason: unknown = 'resolved', context = admin) =>
      new ReleasePayoutHold(gate, deps).execute(context, { holdId, reason });

    it('places a seller hold and a seller-order hold, audited', async () => {
      const seller = await place({ sellerId: SELLER_A, reason: 'admin-review' });
      expect(seller).toMatchObject({
        ok: true,
        value: { sellerId: SELLER_A, sellerOrderId: null, reason: 'admin-review', active: true },
      });
      const order = await place({
        sellerId: SELLER_A,
        sellerOrderId: SELLER_ORDER,
        reason: 'bank-change',
      });
      expect(order).toMatchObject({ ok: true, value: { sellerOrderId: SELLER_ORDER } });
      expect(stores.holds.rows.size).toBe(2);
      expect(audit.entries.map((e) => e.action)).toEqual([
        'commission-payouts.payout-hold.place',
        'commission-payouts.payout-hold.place',
      ]);
      expect(audit.entries[0]!.before).toBeNull();
      expect(audit.entries[0]!.after).toMatchObject({ sellerId: SELLER_A, reason: 'admin-review' });
    });

    it('requires a reason code from the admin set and a valid, known seller and seller order', async () => {
      for (const reason of [undefined, 'seller-suspended', 'dispute', 'refund-pending', 'x']) {
        expect(await place({ sellerId: SELLER_A, reason })).toMatchObject({
          ok: false,
          error: { code: 'validation.failed' },
        });
      }
      expect(await place({ sellerId: 'nope', reason: 'admin-review' })).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
      expect(await place({ sellerId: GHOST, reason: 'admin-review' })).toEqual(
        err({ code: 'commission-payouts.seller-not-found' }),
      );
      // A seller order that is unknown, or belongs to another seller, is not found.
      for (const sellerOrderId of [OTHER_ORDER, SELLER_ORDER]) {
        expect(await place({ sellerId: SELLER_B, sellerOrderId, reason: 'admin-review' })).toEqual(
          err({ code: 'commission-payouts.seller-order-not-found' }),
        );
      }
      expect(stores.holds.rows.size).toBe(0);
      expect(audit.entries).toEqual([]);
    });

    it('releases a hold once, audited with the reason; a second release and an unknown hold are refused', async () => {
      const placed = await place({ sellerId: SELLER_A, reason: 'admin-review' });
      if (!placed.ok) throw new Error('unreachable');
      const holdId = placed.value.holdId;
      expect(await release(holdId, 'nonsense')).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
      expect(await release(holdId, 'review-complete')).toMatchObject({
        ok: true,
        value: { active: false, releaseReason: 'review-complete', releasedAt: T0 },
      });
      expect(await release(holdId)).toEqual(
        err({ code: 'commission-payouts.hold-already-released' }),
      );
      expect(await release(id<'PayoutHold'>(0xfff))).toEqual(
        err({ code: 'commission-payouts.hold-not-found' }),
      );
      expect(audit.entries.at(-1)).toMatchObject({
        action: 'commission-payouts.payout-hold.release',
        targetId: holdId,
        after: { releaseReason: 'review-complete' },
      });
      expect(audit.entries).toHaveLength(2);
    });

    it('lists a seller holds and refuses every caller but an admin', async () => {
      await place({ sellerId: SELLER_A, reason: 'admin-review' });
      const list = (sellerId: unknown, context = admin) =>
        new ListSellerPayoutHolds(gate, deps).execute(context, { sellerId });
      expect(await list(SELLER_A)).toMatchObject({ ok: true, value: [{ reason: 'admin-review' }] });
      expect(await list(SELLER_B)).toEqual(ok([]));
      expect(await list(GHOST)).toEqual(err({ code: 'commission-payouts.seller-not-found' }));
      expect(await list(SELLER_A, sellerA)).toEqual(err({ code: 'access.denied' }));
      expect(await place({ sellerId: SELLER_A, reason: 'admin-review' }, sellerA)).toEqual(
        err({ code: 'access.denied' }),
      );
      expect(await release(id<'PayoutHold'>(1), 'resolved', sellerA)).toEqual(
        err({ code: 'access.denied' }),
      );
      expect(await release(id<'PayoutHold'>(1), 'resolved', system)).toMatchObject({ ok: false });
    });
  });

  describe('the seller-suspended hold from identity events', () => {
    const suspended = (n: number, decisionId: unknown = DECISION, context = system) =>
      new PlaceSellerSuspendedHold(gate, deps).execute(context, {
        delivery: delivery(n, 'commission-payouts.place-suspended-hold'),
        sellerId: SELLER_A,
        decisionId: decisionId as string,
      });
    const reinstated = (n: number, context = system) =>
      new NoteSellerReinstated(gate, deps).execute(context, {
        delivery: delivery(n, 'commission-payouts.note-seller-reinstated'),
        sellerId: SELLER_A,
        decisionId: id<'SellerAccessDecision'>(0xd2),
      });

    it('places one system hold on the whole seller, once per delivery and per decision', async () => {
      expect(await suspended(1)).toEqual(ok('placed'));
      expect(await suspended(1)).toEqual(ok('already-placed'));
      // A second delivery of the same decision (a replay) adds nothing either.
      expect(await suspended(2)).toEqual(ok('already-placed'));
      expect([...stores.holds.rows.values()]).toMatchObject([
        {
          sellerId: SELLER_A,
          sellerOrderId: null,
          reason: 'seller-suspended',
          origin: 'system',
          sourceRef: DECISION,
          placedBy: null,
          releasedAt: null,
        },
      ]);
      expect(audit.entries.map((e) => e.action)).toEqual(['commission-payouts.payout-hold.place']);
      // A new decision is a new hold.
      expect(await suspended(3, id<'SellerAccessDecision'>(0xd3))).toEqual(ok('placed'));
      expect(stores.holds.rows.size).toBe(2);
    });

    it('refuses a malformed event and every caller but the system', async () => {
      expect(await suspended(4, 'nope')).toEqual(err({ code: 'validation.failed' }));
      expect(await suspended(5, DECISION, admin)).toEqual(err({ code: 'access.denied' }));
      expect(stores.holds.rows.size).toBe(0);
    });

    it('never releases the hold on reinstatement: it only logs a notice', async () => {
      await suspended(1);
      expect(await reinstated(2)).toEqual(ok('noted'));
      expect(await reinstated(2)).toEqual(ok('already-noted'));
      expect([...stores.holds.rows.values()].every((h) => h.releasedAt === null)).toBe(true);
      expect(await reinstated(3, admin)).toEqual(err({ code: 'access.denied' }));
    });

    it('lets an admin release the seller-suspended hold', async () => {
      await suspended(1);
      const [hold] = [...stores.holds.rows.values()];
      const result = await new ReleasePayoutHold(gate, deps).execute(admin, {
        holdId: hold!.id,
        reason: 'seller-reinstated',
      });
      expect(result).toMatchObject({
        ok: true,
        value: { reason: 'seller-suspended', active: false, releaseReason: 'seller-reinstated' },
      });
      expect(stores.holds.rows.get(`${market.marketId}:${hold!.id}`)).toMatchObject({
        releasedBy: ADMIN,
      });
    });
  });

  describe('the eligibility anchor', () => {
    const DELIVERED = Temporal.Instant.from('2026-10-10T03:30:00Z');
    const delivered = (
      source: 'carrier' | 'seller-click',
      overrides: Record<string, unknown> = {},
      context = system,
    ) =>
      new RecordSellerOrderDelivered(gate, deps).execute(context, {
        orderId: ORDER,
        sellerOrderId: SELLER_ORDER,
        sellerId: SELLER_A,
        deliveredAt: DELIVERED,
        source,
        ...overrides,
      });
    const anchor = () => stores.anchors.rows.get(`${market.marketId}:${SELLER_ORDER}`);

    it('adds the carrier hold days to a carrier-confirmed delivery', async () => {
      expect(await delivered('carrier')).toEqual(ok('anchored'));
      expect(anchor()).toMatchObject({
        source: 'carrier',
        deliveredAt: DELIVERED,
        holdDaysApplied: marketTerms.holdDaysCarrier,
        eligibleAt: DELIVERED.add({ hours: marketTerms.holdDaysCarrier * 24 }),
      });
    });

    it('adds the longer seller-click hold days to a delivery only the seller confirmed', async () => {
      expect(await delivered('seller-click')).toEqual(ok('anchored'));
      expect(anchor()).toMatchObject({
        source: 'seller-click',
        holdDaysApplied: marketTerms.holdDaysSellerClick,
        eligibleAt: DELIVERED.add({ hours: marketTerms.holdDaysSellerClick * 24 }),
      });
      expect(marketTerms.holdDaysSellerClick).toBeGreaterThan(marketTerms.holdDaysCarrier);
    });

    it("uses the seller's override, frozen at the time of the delivery", async () => {
      await set(SELLER_A, { holdDaysCarrier: 20 });
      await delivered('carrier');
      expect(anchor()).toMatchObject({ holdDaysApplied: 20 });
      // A later change of the terms does not move an anchor that is set.
      await set(SELLER_A, { holdDaysCarrier: 30 }, 1);
      expect(await delivered('carrier', { deliveredAt: DELIVERED.add({ hours: 5 }) })).toEqual(
        ok('already-anchored'),
      );
      expect(anchor()).toMatchObject({ holdDaysApplied: 20, deliveredAt: DELIVERED });
    });

    it('is set once: a later carrier confirmation does not change a seller-click anchor', async () => {
      await delivered('seller-click');
      const before = anchor();
      expect(await delivered('carrier')).toEqual(ok('already-anchored'));
      expect(anchor()).toEqual(before);
      expect(stores.anchors.rows.size).toBe(1);
    });

    it('anchors nothing while the terms are unavailable', async () => {
      build({ marketTerms: () => null });
      expect(await delivered('carrier')).toEqual(
        err({ code: 'commission-payouts.terms-unavailable' }),
      );
      expect(stores.anchors.rows.size).toBe(0);
    });

    it('refuses a malformed fact and every caller but the system', async () => {
      expect(await delivered('carrier', { deliveredAt: '2026-10-10' })).toEqual(
        err({ code: 'validation.failed' }),
      );
      expect(await delivered('other' as never)).toEqual(err({ code: 'validation.failed' }));
      expect(await delivered('carrier', {}, admin)).toEqual(err({ code: 'access.denied' }));
      expect(await delivered('carrier', {}, sellerA)).toMatchObject({ ok: false });
      expect(stores.anchors.rows.size).toBe(0);
    });
  });

  it('keeps the policy under test in use', () => {
    expect(policyTerms).toBeDefined();
  });
});
