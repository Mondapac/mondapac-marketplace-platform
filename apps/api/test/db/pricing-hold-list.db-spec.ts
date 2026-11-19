import { randomBytes } from 'node:crypto';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { FakeOfferSellUnits } from '../support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import { SetRegularPrice } from '../../src/modules/pricing/application/use-cases/set-regular-price.use-case';
import { SetSpecialPrice } from '../../src/modules/pricing/application/use-cases/set-special-price.use-case';
import {
  compareHolds,
  EMPTY_HOLD_FILTER,
  holdMatches,
  type HoldListFilter,
  type HoldSort,
} from '../../src/modules/pricing/domain/hold-list';
import { PRICING_AUDIT_ACTIONS } from '../../src/modules/pricing/domain/audit';
import { PRICING_EVENTS } from '../../src/modules/pricing/domain/events';
import { ConfigPricingPolicyProvider } from '../../src/modules/pricing/infrastructure/config-pricing-policy-provider';
import { PrismaPriceSeriesRepository } from '../../src/modules/pricing/infrastructure/prisma-price-series.repository';
import { PrismaWriteRateCounterRepository } from '../../src/modules/pricing/infrastructure/prisma-write-rate-counter.repository';
import { PrismaWriteRefusalThrottleRepository } from '../../src/modules/pricing/infrastructure/prisma-write-refusal-throttle.repository';
import { AuditActionCatalogue } from '../../src/platform/audit/audit-action-catalogue';
import type { AuditWriter } from '../../src/platform/audit/audit-writer';
import type { AuthorisationCheck } from '../../src/platform/authz';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { EventCatalogue } from '../../src/platform/events/event-catalogue';
import { NO_PERMISSION_KEYS } from '../../src/platform/events/outbox-writer';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { PrismaOutboxWriterFactory } from '../../src/platform/persistence/outbox/prisma-outbox-writer';
import { PersistenceModule } from '../../src/platform/persistence/persistence.module';
import {
  createPersistence,
  marketOf,
  modelMap,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The held-price list on PostgreSQL (super list 19), for both Market fixtures: the repository's
// filters, sorts, counts and page windows against the in-memory twin (`holdMatches`,
// `compareHolds`) that the unit specs use, over regular holds in both Markets and, in AU, held
// specials (ZZ holds only rises).

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };
const gate = createUseCaseGate(markets, admitAll);
const policies = new ConfigPricingPolicyProvider(markets);

const BASE = { AU: { currency: 'AUD', base: 10_000n }, ZZ: { currency: 'JPY', base: 1_000n } };

describe.each(TEST_MARKETS)('held-price list in market %s (database)', (code) => {
  const market: MarketContext = marketOf(code);
  const { currency, base } = BASE[code];
  const clock = new FixedClock(Temporal.Instant.from('2026-10-08T10:00:00Z'));
  const ids = new UuidV7IdGenerator(clock);
  let persistence: Persistence;
  let sql: Client;
  let audit: AuditWriter;
  let offers: FakeOfferSellUnits;
  let throttles: PrismaWriteRefusalThrottleRepository;
  let repository: PrismaPriceSeriesRepository;

  beforeAll(async () => {
    persistence = createPersistence({ pause: () => Promise.resolve() });
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
    throttles = new PrismaWriteRefusalThrottleRepository(persistence.service);
    repository = new PrismaPriceSeriesRepository(persistence.service);
  });
  afterAll(async () => {
    await sql.end();
    await persistence.close();
  });
  beforeEach(() => {
    offers = new FakeOfferSellUnits();
    clock.set(Temporal.Instant.from('2026-10-08T10:00:00Z'));
  });

  function dependencies() {
    const events = new EventCatalogue();
    events.register('pricing', PRICING_EVENTS);
    events.seal();
    return {
      unitOfWork: persistence.unitOfWork,
      series: repository,
      throttles,
      counters: new PrismaWriteRateCounterRepository(persistence.service),
      offers,
      policies,
      audit,
      outbox: new PrismaOutboxWriterFactory(
        modelMap,
        persistence.service,
        events,
        ids,
        NO_PERMISSION_KEYS,
      ).forModule('pricing'),
      clock,
      ids,
    };
  }

  function seller() {
    const sellerId = ids.next<'Seller'>();
    const offerId = ids.next<'Offer'>();
    const variantId = ids.next<'Variant'>();
    const correlationId = `pricing-db-${randomBytes(6).toString('hex')}`;
    const context: CallContext = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId,
      }),
      correlationId,
    );
    offers.put(market, offerId, {
      sellerId,
      productId: ids.next<'Product'>(),
      deleted: false,
      priceableVariantIds: [variantId],
    });
    const regular = (amount: bigint, expectedVersion: number | null) => ({
      offerId,
      variantId,
      price: { amount: amount.toString(), currency },
      expectedVersion,
    });
    const special = (amount: bigint, endsAt: string, expectedVersion: number) => ({
      offerId,
      variantId,
      price: { amount: amount.toString(), currency },
      startsAt: null,
      endsAt,
      expectedVersion,
    });
    return { offerId, variantId, correlationId, context, regular, special };
  }

  it('answers the same as the in-memory twin for every filter, sort and page window', async () => {
    const deps = dependencies();
    const mine = [];
    for (let i = 0; i < 4; i += 1) {
      const s = seller();
      await new SetRegularPrice(gate, deps).execute(s.context, s.regular(base, null));
      clock.set(clock.now().add({ seconds: 5 }));
      // Four and five times the base: held rises of different amounts (ties on purpose).
      const held = await new SetRegularPrice(gate, deps).execute(
        s.context,
        s.regular(base * (i % 2 === 0 ? 4n : 5n), 2),
      );
      if (!held.ok) throw new Error(JSON.stringify(held.error));
      mine.push(s);
      clock.set(clock.now().add({ seconds: 5 }));
    }
    if (code === 'AU') {
      const s = seller();
      await new SetRegularPrice(gate, deps).execute(s.context, s.regular(base, null));
      clock.set(clock.now().add({ seconds: 5 }));
      const special = await new SetSpecialPrice(gate, deps).execute(
        s.context,
        s.special(base / 5n, '2026-10-12T10:00:00Z', 2),
      );
      if (!special.ok) throw new Error(JSON.stringify(special.error));
      mine.push(s);
    }

    const everything = await persistence.unitOfWork.run(
      market,
      async () => ok(await repository.listPendingHolds(market, null, 10_000)),
      { readOnly: true },
    );
    if (!everything.ok) throw new Error('read failed');
    const all = everything.value;
    expect(all.length).toBeGreaterThanOrEqual(mine.length);
    const first = all[0]!;
    const anyAmount = all[Math.floor(all.length / 2)]!.amount.amount;
    const filters: HoldListFilter[] = [
      EMPTY_HOLD_FILTER,
      { ...EMPTY_HOLD_FILTER, kind: 'regular' },
      { ...EMPTY_HOLD_FILTER, kind: 'special' },
      { ...EMPTY_HOLD_FILTER, direction: 'up' },
      { ...EMPTY_HOLD_FILTER, direction: 'down' },
      { ...EMPTY_HOLD_FILTER, sellerId: first.sellerId },
      { ...EMPTY_HOLD_FILTER, recordOrOfferId: first.recordId },
      { ...EMPTY_HOLD_FILTER, recordOrOfferId: first.offerId },
      { ...EMPTY_HOLD_FILTER, from: first.submittedAt },
      { ...EMPTY_HOLD_FILTER, to: first.submittedAt.add({ seconds: 11 }) },
      { ...EMPTY_HOLD_FILTER, minAmount: anyAmount },
      { ...EMPTY_HOLD_FILTER, maxAmount: anyAmount },
      { ...EMPTY_HOLD_FILTER, kind: 'regular', direction: 'up', minAmount: anyAmount },
    ];
    const sorts: HoldSort[] = [
      { key: 'submitted', direction: 'asc' },
      { key: 'submitted', direction: 'desc' },
      { key: 'amount', direction: 'asc' },
      { key: 'amount', direction: 'desc' },
    ];
    for (const filter of filters) {
      for (const sort of sorts) {
        const expected = all
          .filter((hold) => holdMatches(hold, filter))
          .sort((a, b) => compareHolds(a, b, sort))
          .map((hold) => hold.recordId);
        const read = await persistence.unitOfWork.run(
          market,
          async () =>
            ok({
              rows: await repository.queryPendingHolds(market, filter, sort, 0, 10_000),
              count: await repository.countPendingHoldsWhere(market, filter),
              windows: await repository.queryPendingHolds(market, filter, sort, 1, 2),
            }),
          { readOnly: true },
        );
        if (!read.ok) throw new Error('read failed');
        expect(read.value.rows.map((hold) => hold.recordId)).toEqual(expected);
        expect(read.value.count).toBe(expected.length);
        expect(read.value.windows.map((hold) => hold.recordId)).toEqual(expected.slice(1, 3));
      }
    }
  });

  it('counts the views and finds chosen records, leaving a foreign or unknown id out', async () => {
    const deps = dependencies();
    const s = seller();
    await new SetRegularPrice(gate, deps).execute(s.context, s.regular(base, null));
    clock.set(clock.now().add({ seconds: 5 }));
    const held = await new SetRegularPrice(gate, deps).execute(s.context, s.regular(base * 4n, 2));
    if (!held.ok || held.value.recordId === null) throw new Error('no hold');
    const read = await persistence.unitOfWork.run(
      market,
      async () =>
        ok({
          counts: await repository.pendingHoldViewCounts(market),
          all: await repository.countPendingHolds(market),
          found: await repository.findPendingHoldsByIds(market, [
            held.value.recordId!,
            ids.next<'RegularPriceRecord'>(),
          ]),
        }),
      { readOnly: true },
    );
    if (!read.ok) throw new Error('read failed');
    expect(read.value.counts.all).toBe(read.value.all);
    expect(read.value.counts.regular + read.value.counts.special).toBe(read.value.counts.all);
    expect(read.value.counts.up).toBeGreaterThanOrEqual(1);
    expect(read.value.found.map((hold) => hold.recordId)).toEqual([held.value.recordId]);

    const foreign = marketOf(otherMarketOf(code));
    const elsewhere = await persistence.unitOfWork.run(
      foreign,
      async () => ok(await repository.findPendingHoldsByIds(foreign, [held.value.recordId!])),
      { readOnly: true },
    );
    if (!elsewhere.ok) throw new Error('read failed');
    expect(elsewhere.value).toEqual([]);
  });
});
