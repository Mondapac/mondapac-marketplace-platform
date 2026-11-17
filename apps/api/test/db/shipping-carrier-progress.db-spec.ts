import { ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type { ShippingDependencies } from '../../src/modules/shipping/application/shipping-dependencies';
import { CarrierProgressOf } from '../../src/modules/shipping/application/use-cases/carrier-progress-of.use-case';
import { newBooking } from '../../src/modules/shipping/domain/carrier-booking';
import { PrismaCarrierBookingRepository } from '../../src/modules/shipping/infrastructure/prisma-carrier-booking.repository';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../../src/platform/market-context/tenant';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  recordDriverStatements,
  type Persistence,
} from './persistence-support';
import { ownerTestDatabaseUrl } from './test-database';

// The carrier progress read of the admin Shipments list (shipping.carrier_bookings) on
// PostgreSQL, as the application role, in both Market fixtures: ONE statement that selects only
// the six progress columns (never the carrier reference or the tracking link), scoped to the
// caller's Market, and a plan that probes the unique (market_id, seller_order_id) index with both
// columns in its Index Cond on a seeded volume of 100,000 bookings over two Markets (Mojtaba M1,
// M2). The volume rows carry their own carrier status and are removed after the file.

const T0 = Temporal.Instant.from('2026-11-16T09:00:00Z');
const INDEX = 'carrier_bookings_market_id_seller_order_id_key';
const VOLUME_STATUS = 'VOLUME_SEED_PROGRESS';
const VOLUME_PER_MARKET = 50_000;
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

let owner: Client;

beforeAll(async () => {
  owner = new Client({ connectionString: ownerTestDatabaseUrl() });
  await owner.connect();
  // 100,000 delivered bookings over the two Market fixtures (delivered: the poll never reads them).
  for (const code of TEST_MARKETS) {
    await owner.query(
      `INSERT INTO shipping.carrier_bookings (id, market_id, tenant_id, seller_order_id, order_id,
         seller_id, fleet, carrier_reference, progress, carrier_status, version, tracking_url,
         pod_recorded_at, created_at, updated_at)
       SELECT gen_random_uuid(), $1::varchar, $2, gen_random_uuid(), gen_random_uuid(),
         gen_random_uuid(), 'mondapac_drive', 'vol-' || g || '-' || $1::varchar, 'delivered', $3,
         2,
         'https://track.example/' || g, now(), now(), now()
       FROM generate_series(1, $4::int) g`,
      [code, PLATFORM_TENANT_ID, VOLUME_STATUS, VOLUME_PER_MARKET],
    );
  }
  await owner.query('ANALYZE shipping.carrier_bookings');
}, 120_000);

afterAll(async () => {
  await owner.query('DELETE FROM shipping.carrier_bookings WHERE carrier_status = $1', [
    VOLUME_STATUS,
  ]);
  await owner.end();
});

describe.each(TEST_MARKETS)('carrier progress read in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const ids = new UuidV7IdGenerator(new FixedClock(T0));
  let db: Persistence;
  let repository: PrismaCarrierBookingRepository;

  beforeAll(() => {
    db = createPersistence();
    repository = new PrismaCarrierBookingRepository(db.service);
  });
  afterAll(() => db.close());

  const inUnit = async <T>(target: MarketContext, work: () => Promise<T>): Promise<T> => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()), {
      readOnly: true,
    });
    if (!result.ok) throw new Error('unit failed');
    return result.value;
  };

  /** Stores a booking through the repository; returns its seller order id. */
  const stored = async (
    target: MarketContext,
    fields: { sellerOrderId?: Id<'SellerOrder'>; carrierStatus?: string; pod?: boolean } = {},
  ) => {
    const booking = newBooking({
      id: ids.next<'CarrierBooking'>(),
      sellerOrderId: fields.sellerOrderId ?? ids.next<'SellerOrder'>(),
      orderId: ids.next<'Order'>(),
      sellerId: ids.next<'Seller'>(),
      fleet: 'uber_direct',
      carrierReference: `ref-${ids.next()}`,
      carrierStatus: fields.carrierStatus ?? 'SCHEDULED',
      now: T0,
    });
    const result = await db.unitOfWork.run(target, async () =>
      ok(
        await repository.insert(target, {
          ...booking,
          trackingUrl: 'https://track.example/dropoff',
          podRecordedAt: fields.pod === true ? T0.add({ minutes: 40 }) : null,
          updatedAt: T0.add({ minutes: 41 }),
        }),
      ),
    );
    if (!result.ok || result.value !== 'inserted') throw new Error('not stored');
    return booking.sellerOrderId;
  };

  it("reads only the six progress columns, in the caller's Market only", async () => {
    const mine = await stored(market, { pod: true });
    const shared = await stored(market, { carrierStatus: 'MINE' });
    await stored(other, { sellerOrderId: shared, carrierStatus: 'THEIRS' });
    const theirs = await stored(other);
    const unknown = ids.next<'SellerOrder'>();

    const rows = await inUnit(market, () =>
      repository.progressOfSellerOrders(market, [mine, shared, theirs, unknown]),
    );

    expect(rows.map((row) => row.sellerOrderId).sort()).toEqual([mine, shared].sort());
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual([
        'carrierStatus',
        'fleet',
        'podRecordedAt',
        'progress',
        'sellerOrderId',
        'updatedAt',
      ]);
    }
    expect(rows.find((row) => row.sellerOrderId === mine)).toEqual({
      sellerOrderId: mine,
      fleet: 'uber_direct',
      progress: 'booked',
      carrierStatus: 'SCHEDULED',
      updatedAt: T0.add({ minutes: 41 }),
      podRecordedAt: T0.add({ minutes: 40 }),
    });
    expect(rows.find((row) => row.sellerOrderId === shared)?.carrierStatus).toBe('MINE');
    expect(await inUnit(market, () => repository.progressOfSellerOrders(market, []))).toEqual([]);
  });

  it('answers a formula- or markup-shaped stored status as null through the use case', async () => {
    const formula = await stored(market, { carrierStatus: '=1+1' });
    const markup = await stored(market, { carrierStatus: '<b>X</b>' });
    const plain = await stored(market, { carrierStatus: 'OUT_FOR_DELIVERY', pod: true });
    const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
    const deps = {
      unitOfWork: db.unitOfWork,
      bookings: repository,
    } as unknown as ShippingDependencies;
    const admin: CallContext = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
    );

    const answer = await new CarrierProgressOf(gate, deps).execute(admin, {
      sellerOrderIds: [formula, markup, plain],
    });

    if (!answer.ok) throw new Error(answer.error.code);
    expect(answer.value.get(formula)?.carrierStatus).toBeNull();
    expect(answer.value.get(markup)?.carrierStatus).toBeNull();
    expect(answer.value.get(plain)).toEqual({
      fleet: 'uber_direct',
      progress: 'booked',
      carrierStatus: 'OUT_FOR_DELIVERY',
      updatedAt: T0.add({ minutes: 41 }),
      proofOfDelivery: true,
    });
  });

  it('sends ONE statement whose plan probes the unique index with both columns', async () => {
    // 100 seller orders of this Market's volume: the largest page.
    const picked = await owner.query<{ seller_order_id: string }>(
      `SELECT seller_order_id FROM shipping.carrier_bookings
        WHERE market_id = $1 AND carrier_status = $2 LIMIT 100`,
      [code, VOLUME_STATUS],
    );
    const asked = picked.rows.map((row) => row.seller_order_id as Id<'SellerOrder'>);
    expect(asked).toHaveLength(100);

    const recorder = recordDriverStatements();
    let rows: Awaited<ReturnType<typeof repository.progressOfSellerOrders>>;
    try {
      rows = await recorder.during(() =>
        inUnit(market, () => repository.progressOfSellerOrders(market, asked)),
      );
    } finally {
      recorder.restore();
    }
    expect(rows).toHaveLength(100);
    const reads = recorder.statements.filter((text) => /carrier_bookings/.test(text));
    expect(reads).toHaveLength(1);
    const statement = reads[0]!;
    // Only the six columns; never the carrier reference or the tracking link.
    expect(statement).not.toMatch(/carrier_reference|tracking_url/);
    expect(statement).toMatch(/"market_id"\s*=\s*\$1/);

    // The plan of that exact statement, with the values Prisma bound: the Market, then the ids
    // (one `$n` each, or one array), then a trailing `OFFSET $n` of 0 when Prisma adds one.
    const placeholders = new Set(statement.match(/\$\d+/g) ?? []).size;
    const offset = /OFFSET \$\d+\s*$/.test(statement) ? [0] : [];
    const idValues: unknown[] =
      placeholders - 1 - offset.length === asked.length ? [...asked] : [asked];
    const values: unknown[] = [code, ...idValues, ...offset];
    expect(values).toHaveLength(placeholders);
    const explained = await owner.query<{ 'QUERY PLAN': unknown }>(
      `EXPLAIN (FORMAT JSON) ${statement}`,
      values,
    );
    const nodes: Record<string, unknown>[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(walk);
      else if (typeof node === 'object' && node !== null) {
        const record = node as Record<string, unknown>;
        if (typeof record['Node Type'] === 'string') nodes.push(record);
        Object.values(record).forEach(walk);
      }
    };
    walk(explained.rows[0]?.['QUERY PLAN']);
    expect(nodes.filter((node) => node['Node Type'] === 'Seq Scan')).toEqual([]);
    const probe = nodes.find((node) => node['Index Name'] === INDEX);
    expect(probe).toBeDefined();
    expect(probe!['Node Type']).toBe('Index Scan');
    const cond = String(probe!['Index Cond']);
    expect(cond).toMatch(/market_id/);
    expect(cond).toMatch(/seller_order_id/);
  });
});
