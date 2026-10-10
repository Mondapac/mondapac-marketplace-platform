import { randomBytes } from 'node:crypto';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { FakeOfferSellUnits } from '../support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import type { PriceSeriesRepository } from '../../src/modules/pricing/application/ports/price-series.repository';
import { ApprovePriceHold } from '../../src/modules/pricing/application/use-cases/approve-price-hold.use-case';
import { ListPriceHolds } from '../../src/modules/pricing/application/use-cases/list-price-holds.use-case';
import { RejectPriceHold } from '../../src/modules/pricing/application/use-cases/reject-price-hold.use-case';
import { RetireSeriesForRemovedOffer } from '../../src/modules/pricing/application/use-cases/retire-series-for-removed-offer.use-case';
import { RetireSeriesForRemovedVariant } from '../../src/modules/pricing/application/use-cases/retire-series-for-removed-variant.use-case';
import { SetRegularPrice } from '../../src/modules/pricing/application/use-cases/set-regular-price.use-case';
import { ViewPriceHold } from '../../src/modules/pricing/application/use-cases/view-price-hold.use-case';
import { PRICING_AUDIT_ACTIONS } from '../../src/modules/pricing/domain/audit';
import { PRICING_EVENTS } from '../../src/modules/pricing/domain/events';
import { ConfigPricingPolicyProvider } from '../../src/modules/pricing/infrastructure/config-pricing-policy-provider';
import { PrismaPriceSeriesRepository } from '../../src/modules/pricing/infrastructure/prisma-price-series.repository';
import { PrismaRetirementTombstoneRepository } from '../../src/modules/pricing/infrastructure/prisma-retirement-tombstone.repository';
import { PrismaWriteRefusalThrottleRepository } from '../../src/modules/pricing/infrastructure/prisma-write-refusal-throttle.repository';
import { AuditActionCatalogue } from '../../src/platform/audit/audit-action-catalogue';
import type { AuditWriter } from '../../src/platform/audit/audit-writer';
import type { AuthorisationCheck } from '../../src/platform/authz';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import type { EventDelivery } from '../../src/platform/events/event-delivery';
import { EventCatalogue } from '../../src/platform/events/event-catalogue';
import { NO_PERMISSION_KEYS } from '../../src/platform/events/outbox-writer';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { PrismaOutboxWriterFactory } from '../../src/platform/persistence/outbox/prisma-outbox-writer';
import { PersistenceModule } from '../../src/platform/persistence/persistence.module';
import type { HandledOnce, UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import {
  createPersistence,
  gate as openable,
  marketOf,
  modelMap,
  otherMarketOf,
  retryingConflicts,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Pricing slice 4 on PostgreSQL (pricing design 3.1, 6.4, 8, 9): the price-hold review and the
// two retirement handlers, for both Market fixtures, with the real repositories, outbox writer
// and audit writer as the application role. catalog's answer is a fake. The inbox of `runOnce` is
// the platform's (test/db/event-delivery.db-spec.ts); here a set of event ids stands in for it,
// around the real serializable unit.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const policies = new ConfigPricingPolicyProvider(markets);

const BASE = { AU: { currency: 'AUD', base: 10_000n }, ZZ: { currency: 'JPY', base: 1_000n } };

describe.each(TEST_MARKETS)('pricing holds and retirement in market %s (database)', (code) => {
  const market: MarketContext = marketOf(code);
  const { currency, base } = BASE[code];
  const clock = new FixedClock(Temporal.Instant.from('2026-10-10T10:00:00Z'));
  const ids = new UuidV7IdGenerator(clock);
  let persistence: Persistence;
  let sql: Client;
  let audit: AuditWriter;
  let offers: FakeOfferSellUnits;
  let tombstones: PrismaRetirementTombstoneRepository;
  const inbox = new Set<string>();

  beforeAll(async () => {
    persistence = createPersistence();
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    const auditCatalogue = new AuditActionCatalogue();
    auditCatalogue.register('pricing', PRICING_AUDIT_ACTIONS);
    auditCatalogue.seal();
    audit = PersistenceModule.auditWriterFor('pricing').useFactory(
      auditCatalogue,
      ids,
      clock,
      NO_PERMISSION_KEYS,
    ) as AuditWriter;
    tombstones = new PrismaRetirementTombstoneRepository(persistence.service);
  });
  afterAll(async () => {
    await sql.end();
    await persistence.close();
  });
  beforeEach(() => {
    offers = new FakeOfferSellUnits();
    clock.set(Temporal.Instant.from('2026-10-10T10:00:00Z'));
  });

  const repository = (): PriceSeriesRepository =>
    new PrismaPriceSeriesRepository(persistence.service);

  const outbox = () => {
    const events = new EventCatalogue();
    events.register('pricing', PRICING_EVENTS);
    events.seal();
    return new PrismaOutboxWriterFactory(
      modelMap,
      persistence.service,
      events,
      ids,
      NO_PERMISSION_KEYS,
    ).forModule('pricing');
  };

  /** Runs the handler's real serializable unit; an in-memory set is the inbox (see the header). */
  const handledOnce = (): UnitOfWork => ({
    run: (...args) => persistence.unitOfWork.run(...args),
    runOnce: async <T, E>(
      m: Parameters<UnitOfWork['runOnce']>[0],
      delivery: EventDelivery,
      work: () => Promise<Result<T, E>>,
      options?: Parameters<UnitOfWork['runOnce']>[3],
    ): Promise<Result<HandledOnce<T>, E>> => {
      const key = `${m.marketId}|${delivery.eventId}|${delivery.subscriber}`;
      if (inbox.has(key)) return ok({ handled: false });
      const done = await persistence.unitOfWork.run(m, work, options);
      if (!done.ok) return done;
      inbox.add(key);
      return ok({ handled: true, value: done.value });
    },
  });

  const setPrice = (series: PriceSeriesRepository = repository()) =>
    new SetRegularPrice(gate, {
      unitOfWork: persistence.unitOfWork,
      series,
      throttles: new PrismaWriteRefusalThrottleRepository(persistence.service),
      offers,
      policies,
      audit,
      outbox: outbox(),
      clock,
      ids,
    });
  const approve = (series: PriceSeriesRepository = repository()) =>
    new ApprovePriceHold(gate, {
      unitOfWork: persistence.unitOfWork,
      series,
      audit,
      outbox: outbox(),
      clock,
      policies,
    });
  const reject = () =>
    new RejectPriceHold(gate, {
      unitOfWork: persistence.unitOfWork,
      series: repository(),
      audit,
      outbox: outbox(),
      clock,
    });
  const list = () =>
    new ListPriceHolds(gate, { unitOfWork: persistence.unitOfWork, series: repository() });
  const view = () =>
    new ViewPriceHold(gate, { unitOfWork: persistence.unitOfWork, series: repository() });
  const retireDeps = () => ({
    unitOfWork: handledOnce(),
    series: repository(),
    tombstones,
    audit,
    outbox: outbox(),
    clock,
  });
  const retireOffer = () => retryingConflicts(new RetireSeriesForRemovedOffer(gate, retireDeps()));
  const retireVariant = () =>
    retryingConflicts(new RetireSeriesForRemovedVariant(gate, retireDeps()));

  const delivery = (subscriber: string): EventDelivery => ({
    eventId: ids.next<'event'>(),
    subscriber,
    attempt: 1,
  });
  const system = (m: MarketContext = market): CallContext => testCallContext(m, 'system');
  const admin = (m: MarketContext = market, correlationId = unique()): CallContext =>
    testCallContext(
      m,
      testAuthenticatedActor(m, {
        population: 'admin',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
      correlationId,
    );
  const unique = () => `holds-db-${randomBytes(6).toString('hex')}`;

  /** A seller with one Offer and Variant in `m`, and a priced, held series. */
  async function held(m: MarketContext = market, productId = ids.next<'Product'>()) {
    const sellerId = ids.next<'Seller'>();
    const accountId = ids.next<'Account'>();
    const offerId = ids.next<'Offer'>();
    const variantId = ids.next<'Variant'>();
    offers.put(m, offerId, {
      sellerId,
      productId,
      deleted: false,
      priceableVariantIds: [variantId],
    });
    const context = testCallContext(
      m,
      testAuthenticatedActor(m, {
        population: 'seller',
        accountId,
        sessionId: ids.next<'Session'>(),
        sellerId,
      }),
      unique(),
    );
    const cur = BASE[m.marketId as 'AU' | 'ZZ'];
    const input = (amount: bigint, expectedVersion: number | null) => ({
      offerId,
      variantId,
      price: { amount: amount.toString(), currency: cur.currency },
      expectedVersion,
    });
    const first = await setPrice().execute(context, input(cur.base, null));
    expect(first.ok).toBe(true);
    clock.set(clock.now().add({ seconds: 5 }));
    const second = await setPrice().execute(context, input(cur.base * 4n, 2));
    if (!second.ok || second.value.recordId === null) throw new Error('no hold');
    clock.set(clock.now().add({ seconds: 5 }));
    return {
      sellerId,
      accountId,
      offerId,
      variantId,
      productId,
      context,
      input,
      recordId: second.value.recordId,
    };
  }

  const seriesOf = async (offerId: string) =>
    (
      await sql.query<{
        id: string;
        version: number;
        retired_at: Date | null;
        retire_cause: string | null;
      }>(
        'SELECT id, version, retired_at, retire_cause FROM pricing.price_series WHERE market_id = $1 AND offer_id = $2',
        [code, offerId],
      )
    ).rows;
  const recordsOf = async (seriesId: string) =>
    (
      await sql.query<{
        id: string;
        status: string;
        effective_from: Date | null;
        effective_to: Date | null;
        decided_by_account_id: string | null;
        decision_reason_code: string | null;
        decision_note: string | null;
        supersede_cause: string | null;
      }>(
        `SELECT id, status, effective_from, effective_to, decided_by_account_id, decision_reason_code,
          decision_note, supersede_cause FROM pricing.regular_price_records
        WHERE market_id = $1 AND series_id = $2 ORDER BY submitted_at, id`,
        [code, seriesId],
      )
    ).rows;
  const eventsOf = async (seriesId: string) =>
    (
      await sql.query<{
        type: string;
        aggregate_version: number;
        payload: Record<string, unknown>;
      }>(
        `SELECT type, aggregate_version, payload FROM pricing.outbox
        WHERE market_id = $1 AND aggregate_id = $2 ORDER BY aggregate_version`,
        [code, seriesId],
      )
    ).rows;
  const auditOf = async (seriesId: string) =>
    (
      await sql.query<{ action: string; actor_type: string; after: Record<string, unknown> }>(
        `SELECT action, actor_type, after FROM platform.audit_log
        WHERE market_id = $1 AND target_id = $2 ORDER BY occurred_at, id`,
        [code, seriesId],
      )
    ).rows;

  describe('the price-hold review', () => {
    it('approves from now: the decision, the closed period, the events and the audit row', async () => {
      const h = await held();
      const decider = admin();
      const result = await approve().execute(decider, { recordId: h.recordId });
      expect(result).toMatchObject({
        ok: true,
        value: { outcome: 'approved', seriesVersion: 5 },
      });

      const [series] = await seriesOf(h.offerId);
      const records = await recordsOf(series!.id);
      expect(records.map((r) => r.status)).toEqual(
        ['approved'].length ? ['accepted', 'approved'] : [],
      );
      const [first, approved] = records;
      expect(approved!.effective_from!.getTime()).toBe(clock.now().epochMilliseconds);
      expect(first!.effective_to!.getTime()).toBe(approved!.effective_from!.getTime());
      expect(approved!.decided_by_account_id).toBe(
        decider.actor.kind === 'authenticated' ? decider.actor.accountId : null,
      );

      const events = await eventsOf(series!.id);
      expect(events.slice(-2).map((e) => [e.type, e.aggregate_version])).toEqual([
        ['pricing.price-hold-decided.v1', 4],
        ['pricing.effective-price-changed.v1', 5],
      ]);
      expect(events.slice(-2).map((e) => e.payload['outcome'] ?? e.payload['cause'])).toEqual([
        'approved',
        'hold-approved',
      ]);
      expect(JSON.stringify(events.map((e) => e.payload))).not.toMatch(/"amount"/u);

      const rows = await auditOf(series!.id);
      const row = rows.find((r) => r.action === 'pricing.price-hold.approved');
      expect(row).toMatchObject({
        actor_type: 'USER',
        after: {
          recordId: h.recordId,
          amount: { amount: (base * 4n).toString(), currency },
          anchorAmount: { amount: base.toString(), currency },
        },
      });
      // Decided: no longer in the queue.
      expect(await view().execute(decider, { recordId: h.recordId })).toEqual({
        ok: false,
        error: { code: 'pricing.hold.not-found' },
      });
      expect(await approve().execute(admin(), { recordId: h.recordId })).toEqual({
        ok: false,
        error: { code: 'pricing.hold.not-pending' },
      });
    });

    it('refuses the submitting account and writes nothing; the table refuses it too (H4)', async () => {
      const h = await held();
      const [series] = await seriesOf(h.offerId);
      const sameAccount: CallContext = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId: h.accountId,
          sessionId: ids.next<'Session'>(),
          sellerId: null,
        }),
        unique(),
      );
      expect(await approve().execute(sameAccount, { recordId: h.recordId })).toEqual({
        ok: false,
        error: { code: 'pricing.hold.own-submission' },
      });
      expect(
        await reject().execute(sameAccount, { recordId: h.recordId, reasonCode: 'other' }),
      ).toEqual({ ok: false, error: { code: 'pricing.hold.own-submission' } });
      expect((await recordsOf(series!.id)).map((r) => r.status)).toEqual([
        'accepted',
        'pending-review',
      ]);
      expect((await seriesOf(h.offerId))[0]!.version).toBe(3);
    });

    it('rejects with a reason code: the note is on the record, never in the audit row or an event', async () => {
      const h = await held();
      const [series] = await seriesOf(h.offerId);
      const result = await reject().execute(admin(), {
        recordId: h.recordId,
        reasonCode: 'price-implausible',
        note: '  looks like a typo, ask the seller  ',
      });
      expect(result).toMatchObject({ ok: true, value: { outcome: 'rejected', seriesVersion: 4 } });

      const records = await recordsOf(series!.id);
      expect(records[1]).toMatchObject({
        status: 'rejected',
        effective_from: null,
        decision_reason_code: 'price-implausible',
        decision_note: 'looks like a typo, ask the seller',
      });
      expect(records[0]!.effective_to).toBeNull();
      const audit = (await auditOf(series!.id)).find(
        (r) => r.action === 'pricing.price-hold.rejected',
      );
      expect(audit?.after).toMatchObject({ reasonCode: 'price-implausible' });
      expect(JSON.stringify(audit)).not.toContain('typo');
      const events = await eventsOf(series!.id);
      expect(events[events.length - 1]).toMatchObject({
        type: 'pricing.price-hold-decided.v1',
        aggregate_version: 4,
        payload: { outcome: 'rejected' },
      });
      expect(JSON.stringify(events)).not.toContain('typo');
    });

    it("never shows, decides or lists another Market's record", async () => {
      const foreign = marketOf(otherMarketOf(code));
      const mine = await held();
      const theirs = await held(foreign);
      const decider = admin();
      expect(await view().execute(decider, { recordId: theirs.recordId })).toEqual({
        ok: false,
        error: { code: 'pricing.hold.not-found' },
      });
      expect(await approve().execute(decider, { recordId: theirs.recordId })).toEqual({
        ok: false,
        error: { code: 'pricing.hold.not-found' },
      });
      expect(
        await reject().execute(decider, { recordId: theirs.recordId, reasonCode: 'other' }),
      ).toEqual({ ok: false, error: { code: 'pricing.hold.not-found' } });

      const seen: string[] = [];
      let after: string | null = null;
      do {
        const page = await list().execute(decider, { after, limit: 100 });
        if (!page.ok) throw new Error('list failed');
        seen.push(...page.value.items.map((i) => i.recordId));
        after = page.value.next;
      } while (after !== null);
      expect(seen).toContain(mine.recordId);
      expect(seen).not.toContain(theirs.recordId);
      // The foreign record is untouched.
      const [series] = (
        await sql.query<{ id: string }>(
          'SELECT id FROM pricing.price_series WHERE market_id = $1 AND offer_id = $2',
          [foreign.marketId, theirs.offerId],
        )
      ).rows;
      const statuses = await sql.query<{ status: string }>(
        'SELECT status FROM pricing.regular_price_records WHERE market_id = $1 AND series_id = $2 ORDER BY submitted_at',
        [foreign.marketId, series!.id],
      );
      expect(statuses.rows.map((r) => r.status)).toEqual(['accepted', 'pending-review']);
    });

    it('lists the queue oldest first and pages by keyset', async () => {
      const a = await held();
      const b = await held();
      const c = await held();
      const decider = admin();
      const all: string[] = [];
      let after: string | null = null;
      let pages = 0;
      do {
        const page = await list().execute(decider, { after, limit: 1 });
        if (!page.ok) throw new Error('list failed');
        expect(page.value.items.length).toBeLessThanOrEqual(1);
        all.push(...page.value.items.map((i) => i.recordId));
        after = page.value.next;
        pages += 1;
      } while (after !== null);
      expect(pages).toBeGreaterThanOrEqual(3);
      expect(
        all.filter((id) => [a.recordId, b.recordId, c.recordId].includes(id as never)),
      ).toEqual([a.recordId, b.recordId, c.recordId]);
    });

    it('lets a concurrent seller write win over a stale approval: conflict.stale, never both', async () => {
      const h = await held();
      const [series] = await seriesOf(h.offerId);
      const inner = repository();
      const loaded = openable();
      const sellerDone = openable();
      const racing: PriceSeriesRepository = {
        ...inner,
        findByKey: (m, key) => inner.findByKey(m, key),
        findByOffer: (m, o) => inner.findByOffer(m, o),
        findByProductVariant: (m, p, v) => inner.findByProductVariant(m, p, v),
        listPendingHolds: (m, a, l) => inner.listPendingHolds(m, a, l),
        findPendingHold: (m, r) => inner.findPendingHold(m, r),
        add: (m, s) => inner.add(m, s),
        save: (m, s) => inner.save(m, s),
        findByRecordId: async (m, id) => {
          const found = await inner.findByRecordId(m, id);
          loaded.open();
          await sellerDone.opened;
          return found;
        },
      };
      const approving = approve(racing).execute(admin(), { recordId: h.recordId });
      await loaded.opened;
      // The seller writes a new price while the admin's screen is open: the pending record is
      // superseded (version 3 -> 5).
      const rewrite = await setPrice().execute(h.context, h.input(base * 4n + 1n, 3));
      expect(rewrite).toMatchObject({ ok: true, value: { status: 'pending-review' } });
      sellerDone.open();

      expect(await approving).toEqual({ ok: false, error: { code: 'conflict.stale' } });
      const records = await recordsOf(series!.id);
      expect(records.map((r) => r.status)).toEqual(['accepted', 'superseded', 'pending-review']);
      expect(records.filter((r) => r.status === 'approved')).toHaveLength(0);
    });
  });

  describe('the retirement handlers', () => {
    it('retires every series of a deleted Offer, supersedes the pending record, and is idempotent', async () => {
      const h = await held();
      const [series] = await seriesOf(h.offerId);
      const event = delivery('pricing.retire-series-for-removed-offer');

      const result = await retireOffer().execute(system(), { delivery: event, offerId: h.offerId });
      expect(result).toEqual({
        ok: true,
        value: { code: 'pricing.series-retired', series: 1, superseded: 1 },
      });

      const [after] = await seriesOf(h.offerId);
      expect(after).toMatchObject({ retire_cause: 'offer-removed', version: 5 });
      expect(after!.retired_at).not.toBeNull();
      const records = await recordsOf(series!.id);
      expect(records.map((r) => [r.status, r.supersede_cause])).toEqual([
        ['accepted', null],
        ['superseded', 'offer-removed'],
      ]);
      const events = await eventsOf(series!.id);
      expect(events.slice(-2).map((e) => [e.type, e.aggregate_version])).toEqual([
        ['pricing.price-hold-decided.v1', 4],
        ['pricing.effective-price-changed.v1', 5],
      ]);
      expect(events[events.length - 2]!.payload).toMatchObject({
        recordId: h.recordId,
        outcome: 'superseded',
      });
      expect(events[events.length - 1]!.payload).toMatchObject({ cause: 'series-retired' });
      const rows = await auditOf(series!.id);
      // One clock instant for both rows: compare as a set.
      expect(
        rows
          .slice(-2)
          .map((r) => [r.action, r.actor_type])
          .sort(),
      ).toEqual([
        ['pricing.regular-price.superseded', 'SYSTEM'],
        ['pricing.series.retired', 'SYSTEM'],
      ]);
      const tombstone = await sql.query(
        'SELECT 1 FROM pricing.retired_offers WHERE market_id = $1 AND offer_id = $2',
        [code, h.offerId],
      );
      expect(tombstone.rowCount).toBe(1);

      // The same delivery again changes nothing.
      expect(
        await retireOffer().execute(system(), { delivery: event, offerId: h.offerId }),
      ).toEqual({ ok: true, value: { code: 'pricing.retire.already-handled' } });
      // A second event for the same Offer finds the series retired and writes no new row.
      expect(
        await retireOffer().execute(system(), {
          delivery: delivery('pricing.retire-series-for-removed-offer'),
          offerId: h.offerId,
        }),
      ).toEqual({ ok: true, value: { code: 'pricing.series-retired', series: 0, superseded: 0 } });
      expect((await eventsOf(series!.id)).length).toBe(events.length);
      expect((await auditOf(series!.id)).length).toBe(rows.length);
      expect((await seriesOf(h.offerId))[0]!.version).toBe(5);
    });

    it('records the permanent tombstone when no series exists, and refuses the later first price', async () => {
      const sellerId = ids.next<'Seller'>();
      const offerId = ids.next<'Offer'>();
      const variantId = ids.next<'Variant'>();
      const productId = ids.next<'Product'>();
      offers.put(market, offerId, {
        sellerId,
        productId,
        deleted: false,
        priceableVariantIds: [variantId],
      });

      expect(
        await retireOffer().execute(system(), {
          delivery: delivery('pricing.retire-series-for-removed-offer'),
          offerId,
        }),
      ).toEqual({ ok: true, value: { code: 'pricing.series-retired', series: 0, superseded: 0 } });
      expect(
        (
          await sql.query(
            'SELECT 1 FROM pricing.retired_offers WHERE market_id = $1 AND offer_id = $2',
            [code, offerId],
          )
        ).rowCount,
      ).toBe(1);

      // catalog's advisory answer still says the Offer is fine (stale): the tombstone refuses.
      const context = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'seller',
          accountId: ids.next<'Account'>(),
          sessionId: ids.next<'Session'>(),
          sellerId,
        }),
        unique(),
      );
      const result = await setPrice().execute(context, {
        offerId,
        variantId,
        price: { amount: base.toString(), currency },
        expectedVersion: null,
      });
      expect(result).toEqual({ ok: false, error: { code: 'pricing.offer-not-found' } });
      expect(await seriesOf(offerId)).toEqual([]);
    });

    it('retires the series of a removed Variant across Offers, and refuses a later price for it', async () => {
      const productId = ids.next<'Product'>();
      const a = await held(market, productId);
      const b = await held(market, productId);
      // Two Offers of one product, each with its own Variant: only `a`'s Variant is removed.
      const event = delivery('pricing.retire-series-for-removed-variant');
      const result = await retireVariant().execute(system(), {
        delivery: event,
        productId,
        variantId: a.variantId,
      });
      expect(result).toEqual({
        ok: true,
        value: { code: 'pricing.series-retired', series: 1, superseded: 1 },
      });
      expect((await seriesOf(a.offerId))[0]).toMatchObject({ retire_cause: 'variant-removed' });
      // The other Offer's Variant is another Variant: untouched.
      expect((await seriesOf(b.offerId))[0]!.retired_at).toBeNull();
      const [series] = await seriesOf(a.offerId);
      expect((await recordsOf(series!.id)).map((r) => r.supersede_cause)).toEqual([
        null,
        'variant-removed',
      ]);
      expect(
        (
          await sql.query(
            'SELECT 1 FROM pricing.retired_variants WHERE market_id = $1 AND product_id = $2 AND variant_id = $3',
            [code, productId, a.variantId],
          )
        ).rowCount,
      ).toBe(1);

      // A retired series takes no write; a price for the removed Variant is not found.
      expect(await setPrice().execute(a.context, a.input(base, 5))).toEqual({
        ok: false,
        error: { code: 'pricing.series-retired' },
      });
      // The record is superseded and the series retired: an approval answers the series first.
      expect(await approve().execute(admin(), { recordId: a.recordId })).toEqual({
        ok: false,
        error: { code: 'pricing.series-retired' },
      });
    });

    it('never lets an approval and a retirement both win: a stale approval answers conflict.stale', async () => {
      const h = await held();
      const [series] = await seriesOf(h.offerId);
      const inner = repository();
      const loaded = openable();
      const retired = openable();
      const racing: PriceSeriesRepository = {
        ...inner,
        findByKey: (m, key) => inner.findByKey(m, key),
        findByOffer: (m, o) => inner.findByOffer(m, o),
        findByProductVariant: (m, p, v) => inner.findByProductVariant(m, p, v),
        listPendingHolds: (m, a, l) => inner.listPendingHolds(m, a, l),
        findPendingHold: (m, r) => inner.findPendingHold(m, r),
        add: (m, s) => inner.add(m, s),
        save: (m, s) => inner.save(m, s),
        findByRecordId: async (m, id) => {
          const found = await inner.findByRecordId(m, id);
          loaded.open();
          await retired.opened;
          return found;
        },
      };
      const approving = approve(racing).execute(admin(), { recordId: h.recordId });
      await loaded.opened;
      await retireOffer().execute(system(), {
        delivery: delivery('pricing.retire-series-for-removed-offer'),
        offerId: h.offerId,
      });
      retired.open();

      expect(await approving).toEqual({ ok: false, error: { code: 'conflict.stale' } });
      const records = await recordsOf(series!.id);
      expect(records.map((r) => r.status)).toEqual(['accepted', 'superseded']);
    });

    it('lets a retirement that overlaps an approval run again and see the approved record', async () => {
      const h = await held();
      const [series] = await seriesOf(h.offerId);
      // The handler reads the series (pending), the admin approves meanwhile, the handler's
      // write is refused as a serialization failure and the unit runs again on the new state.
      const inner = repository();
      const read = openable();
      const approved = openable();
      let reads = 0;
      const racing: PriceSeriesRepository = {
        ...inner,
        findByKey: (m, key) => inner.findByKey(m, key),
        findByRecordId: (m, id) => inner.findByRecordId(m, id),
        listPendingHolds: (m, a, l) => inner.listPendingHolds(m, a, l),
        findPendingHold: (m, r) => inner.findPendingHold(m, r),
        findByProductVariant: (m, p, v) => inner.findByProductVariant(m, p, v),
        add: (m, s) => inner.add(m, s),
        save: (m, s) => inner.save(m, s),
        findByOffer: async (m, o) => {
          const found = await inner.findByOffer(m, o);
          reads += 1;
          if (reads === 1) {
            read.open();
            await approved.opened;
          }
          return found;
        },
      };
      const retiring = retryingConflicts(
        new RetireSeriesForRemovedOffer(gate, { ...retireDeps(), series: racing }),
      ).execute(system(), {
        delivery: delivery('pricing.retire-series-for-removed-offer'),
        offerId: h.offerId,
      });
      await read.opened;
      expect(await approve().execute(admin(), { recordId: h.recordId })).toMatchObject({
        ok: true,
      });
      approved.open();

      expect(await retiring).toMatchObject({ ok: true, value: { code: 'pricing.series-retired' } });
      const records = await recordsOf(series!.id);
      expect(records.map((r) => r.status)).toEqual(['accepted', 'approved']);
      expect((await seriesOf(h.offerId))[0]!.retired_at).not.toBeNull();
      expect(reads).toBeGreaterThanOrEqual(2);
    });
  });
});
