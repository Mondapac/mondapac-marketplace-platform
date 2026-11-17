import type { CallContext, MarketContext, Result } from '@mondapac/shared-kernel';
import { Temporal } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeCarrierProgress, FakeLabels } from '../../../../test/support/ordering-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../platform/authz';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import {
  shipmentRowActions,
  shipmentStage,
  type ShipmentCursor,
  type ShipmentListFilter,
  type ShipmentListRecord,
  type ShipmentSort,
} from '../domain/admin-shipment-list';
import type { AdminShipmentListReader } from './ports/admin-shipment-list.reader';
import { AdminListShipments } from './use-cases/admin-list-shipments.use-case';

// The admin Shipments list in memory, on both Market fixtures: the view key, every query check,
// the search resolved by the owning modules (and failing closed), the names that never fail the
// read, the stage of each row and its actions. The SQL is in
// test/db/ordering-shipment-list.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-11-15T10:00:00Z');
const VIEW = 'ordering.order.view';

class RecordingReader implements AdminShipmentListReader {
  records: ShipmentListRecord[] = [];
  asked: {
    filter: ShipmentListFilter;
    sort: ShipmentSort;
    offset: number;
    limit: number;
    after?: ShipmentCursor;
  }[] = [];
  page(
    _m: MarketContext,
    filter: ShipmentListFilter,
    sort: ShipmentSort,
    offset: number,
    limit: number,
    after: ShipmentCursor | null = null,
  ) {
    this.asked.push({ filter, sort, offset, limit, ...(after === null ? {} : { after }) });
    return Promise.resolve(this.records.slice(offset, offset + limit));
  }
  counted = 0;
  count() {
    this.counted += 1;
    return Promise.resolve(this.records.length);
  }
  countByStage() {
    return Promise.resolve({
      toPrepare: 1,
      ready: 2,
      shipped: 3,
      delivered: 4,
      refunded: 6,
      attention: 5,
    });
  }
}

describe.each(['AU', 'ZZ'] as const)('admin shipment list in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const currency = code === 'AU' ? 'AUD' : 'JPY';
  const ids = new SequenceIdGenerator(new FixedClock(T0));

  function setup(keys: readonly string[] = [VIEW]) {
    const check: AuthorisationCheck = {
      check: (_context, declaration) => {
        const needs = declaration.rule.kind === 'permissions' ? declaration.rule.allOf : [];
        return Promise.resolve(
          needs.every((key) => keys.includes(key))
            ? { allowed: true }
            : { allowed: false, denial: { code: 'access.denied' } },
        );
      },
    };
    // What happened in order: each read unit opening and closing, and each progress call.
    const events: string[] = [];
    const unitOfWork = {
      run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => {
        events.push('unit-open');
        try {
          return await work();
        } finally {
          events.push('unit-closed');
        }
      },
    } as unknown as UnitOfWork;
    const reader = new RecordingReader();
    const labels = new FakeLabels();
    const carrierProgress = new FakeCarrierProgress();
    carrierProgress.onCall = () => events.push('carrier-progress');
    const list = new AdminListShipments(createUseCaseGate(markets, check), {
      unitOfWork,
      shipments: reader,
      labels,
      carrierProgress,
    });
    const context: CallContext = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
    );
    return { list, reader, labels, carrierProgress, events, context };
  }

  const record = (overrides: Partial<ShipmentListRecord> = {}): ShipmentListRecord => ({
    sellerOrderId: ids.next<'SellerOrder'>(),
    orderId: ids.next<'Order'>(),
    sellerId: ids.next<'Seller'>(),
    accountId: ids.next<'Account'>(),
    paidAt: T0,
    deliveryMethod: 'instant',
    deliveryWindow: null,
    fulfilment: 'to-ship',
    readyAt: null,
    shippedAt: null,
    deliveredAt: null,
    carrier: null,
    trackingRef: null,
    fleet: null,
    deliveryAttention: null,
    shipping: { amount: 500n, currency },
    total: { amount: 1500n, currency },
    refunded: { amount: 0n, currency },
    ...overrides,
  });

  const fieldsOf = (result: Result<unknown, { code: string }>) =>
    !result.ok && 'fields' in result.error
      ? (result.error as { fields: { path: string; code: string }[] }).fields
      : [];

  it('needs ordering.order.view', async () => {
    expect(AdminListShipments.access.rule).toEqual({ kind: 'permissions', allOf: [VIEW] });
    const { list, reader, context } = setup([]);
    const result = await list.execute(context, {});
    expect(!result.ok && result.error.code).toBe('access.denied');
    expect(reader.asked).toEqual([]);
  });

  it('answers the first page, newest payment first, with the stage counts as the total', async () => {
    const { list, reader, context } = setup();
    reader.records = [record(), record()];
    const result = await list.execute(context, {});
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value).toMatchObject({
      total: 16,
      page: 1,
      pageSize: 25,
      counts: { toPrepare: 1, ready: 2, shipped: 3, delivered: 4, refunded: 6, attention: 5 },
    });
    expect(reader.counted).toBe(0);
    expect(reader.asked[0]).toMatchObject({
      sort: { key: 'paid', direction: 'desc' },
      offset: 0,
      limit: 25,
    });
  });

  it('passes every filter to the reader, parsed', async () => {
    const { list, reader, context } = setup();
    const sellerId = ids.next<'Seller'>();
    const reference = ids.next<'SellerOrder'>();
    const result = await list.execute(context, {
      page: 2,
      pageSize: 10,
      sort: 'shipped',
      direction: 'asc',
      stage: 'ready',
      q: reference,
      deliveryMethod: 'scheduled',
      attention: 'any',
      fleet: 'uber_direct',
      sellerId,
      paidFrom: '2026-11-01T00:00:00Z',
      paidTo: '2026-11-02T00:00:00Z',
      shippedFrom: '2026-11-03T00:00:00Z',
      shippedTo: '2026-11-04T00:00:00Z',
    });
    expect(result.ok).toBe(true);
    expect(reader.asked[0]).toEqual({
      filter: {
        ids: null,
        stage: 'ready',
        reference,
        trackingRef: null,
        deliveryMethod: 'scheduled',
        attention: 'any',
        fleet: 'uber_direct',
        sellerId,
        paidFrom: Temporal.Instant.from('2026-11-01T00:00:00Z'),
        paidTo: Temporal.Instant.from('2026-11-02T00:00:00Z'),
        shippedFrom: Temporal.Instant.from('2026-11-03T00:00:00Z'),
        shippedTo: Temporal.Instant.from('2026-11-04T00:00:00Z'),
        parties: null,
      },
      sort: { key: 'shipped', direction: 'asc' },
      offset: 10,
      limit: 10,
    });
  });

  it('reads a text that is not an id as an exact tracking reference, spaces included', async () => {
    const { list, reader, context } = setup();
    await list.execute(context, { q: ' AP-12345678 ' });
    expect(reader.asked[0]!.filter).toMatchObject({ trackingRef: 'AP-12345678', reference: null });
    // The seller's ship input allows inner spaces (order.ts TRACKING), so the search does too.
    const spaced = await list.execute(context, { q: 'JD 0123 4567' });
    expect(spaced.ok).toBe(true);
    expect(reader.asked[1]!.filter.trackingRef).toBe('JD 0123 4567');
  });

  it('takes a tab total from the counts and counts only a narrower filter', async () => {
    const { list, reader, context } = setup();
    const tab = async (input: Record<string, unknown>) => {
      const result = await list.execute(context, input);
      return result.ok ? result.value.total : null;
    };
    expect(await tab({ stage: 'to-prepare' })).toBe(1);
    expect(await tab({ stage: 'refunded' })).toBe(6);
    expect(await tab({ attention: 'any' })).toBe(5);
    expect(reader.counted).toBe(0);
    reader.records = [record()];
    expect(await tab({ stage: 'ready', deliveryMethod: 'pickup' })).toBe(1);
    expect(await tab({ stage: 'ready', attention: 'any' })).toBe(1);
    expect(reader.counted).toBe(2);
  });

  it('refuses every malformed field at once, before reading', async () => {
    const { list, reader, context } = setup();
    const result = await list.execute(context, {
      page: 0,
      pageSize: 0,
      sort: 'customer',
      direction: 'up',
      stage: 'lost',
      deliveryMethod: 'drone',
      attention: 'late',
      q: 'not <a> ref',
      search: 'x',
      fleet: 'Uber Direct',
      sellerId: 'abc',
      paidFrom: 'yesterday',
      paidTo: '2026-11-02',
      shippedFrom: 1,
      shippedTo: 'soon',
    });
    expect(fieldsOf(result).map((f) => `${f.path}:${f.code}`)).toEqual([
      'page:range',
      'pageSize:range',
      'sort:value',
      'direction:value',
      'stage:value',
      'deliveryMethod:value',
      'attention:value',
      'q:format',
      'search:length',
      'fleet:format',
      'sellerId:format',
      'paidFrom:format',
      'paidTo:format',
      'shippedFrom:format',
      'shippedTo:format',
    ]);
    expect(reader.asked).toEqual([]);
  });

  it('walks Previous/Next pages newest payment first, past row 10,000, with no total', async () => {
    const { list, reader, context } = setup();
    const rows = [record(), record(), record()];
    reader.records = rows;
    const first = await list.execute(context, { limit: 2 });
    if (!first.ok) throw new Error(first.error.code);
    expect(first.value).toMatchObject({ total: null, page: null, pageSize: 2 });
    expect(first.value.rows.map((r) => r.sellerOrderId)).toEqual([
      rows[0]!.sellerOrderId,
      rows[1]!.sellerOrderId,
    ]);
    expect(first.value.nextCursor).toBe(`${T0.epochMilliseconds}.${rows[1]!.sellerOrderId}`);
    expect(reader.asked[0]).toMatchObject({
      sort: { key: 'paid', direction: 'desc' },
      offset: 0,
      limit: 3,
    });
    expect(reader.counted).toBe(0);

    reader.records = [rows[2]!];
    const last = await list.execute(context, { cursor: first.value.nextCursor, limit: 2 });
    expect(reader.asked[1]!.after).toEqual({ paidAt: T0, sellerOrderId: rows[1]!.sellerOrderId });
    expect(last.ok && last.value.nextCursor).toBeNull();
  });

  it('refuses a malformed cursor and page-mode fields beside it', async () => {
    const { list, reader, context } = setup();
    const result = await list.execute(context, {
      cursor: 'not-a-cursor',
      limit: 101,
      page: 2,
      sort: 'total',
    });
    expect(fieldsOf(result).map((f) => `${f.path}:${f.code}`)).toEqual([
      'page:with-cursor',
      'sort:with-cursor',
      'cursor:format',
      'limit:range',
    ]);
    expect(reader.asked).toEqual([]);
  });

  it('refuses reversed time ranges and pages past 10,000 rows', async () => {
    const { list, context } = setup();
    const reversed = await list.execute(context, {
      paidFrom: '2026-11-02T00:00:00Z',
      paidTo: '2026-11-01T00:00:00Z',
      shippedFrom: '2026-11-02T00:00:00Z',
      shippedTo: '2026-11-02T00:00:00Z',
    });
    expect(fieldsOf(reversed)).toEqual([
      { path: 'paidTo', code: 'range' },
      { path: 'shippedTo', code: 'range' },
    ]);
    const deep = await list.execute(context, { page: 401, pageSize: 25 });
    expect(fieldsOf(deep)).toEqual([{ path: 'page', code: 'too-deep' }]);
  });

  it('resolves the search through the owning modules and fails closed', async () => {
    const { list, reader, labels, context } = setup();
    const sellerId = ids.next<'Seller'>();
    labels.stores.set(sellerId, 'Amin Grocers');
    const found = await list.execute(context, { search: 'amin' });
    expect(found.ok && found.value.searchScope).toBe('customers-and-stores');
    expect(reader.asked[0]!.filter.parties).toEqual({ accountIds: [], sellerIds: [sellerId] });

    labels.fail.add('customers');
    const failed = await list.execute(context, { search: 'amin' });
    expect(!failed.ok && failed.error.code).toBe('ordering.search-unavailable');
    expect(reader.asked).toHaveLength(1);
  });

  it('adds names, the stage and the actions; a failed lookup leaves names null', async () => {
    const { list, reader, labels, context } = setup();
    const row = record({ readyAt: T0, fulfilment: 'shipped', trackingRef: 'TRK-1' });
    reader.records = [row];
    labels.stores.set(row.sellerId, 'Halal Corner');
    const named = await list.execute(context, {});
    expect(named.ok && named.value.rows[0]).toMatchObject({
      storeName: 'Halal Corner',
      customer: null,
      stage: 'shipped',
      actions: ['view-order', 'copy-tracking-reference'],
    });
    labels.fail.add('stores');
    const unnamed = await list.execute(context, {});
    expect(unnamed.ok && unnamed.value.rows[0]!.storeName).toBeNull();
  });

  it('reads the carrier progress once per page, after the read unit, for the asked ids only', async () => {
    const { list, reader, carrierProgress, events, context } = setup();
    const booked = record({ readyAt: T0, fulfilment: 'shipped', carrier: 'Courier' });
    const pickup = record({ deliveryMethod: 'pickup' });
    reader.records = [booked, pickup];
    const progress = {
      progress: 'picked-up' as const,
      carrierStatus: 'EN_ROUTE',
      updatedAt: T0.add({ minutes: 20 }),
      proofOfDelivery: false,
      fleet: 'uber_direct',
    };
    carrierProgress.progress.set(booked.sellerOrderId, progress);
    // An id shipping adds that was not asked for is never shown.
    const extra = ids.next<'SellerOrder'>();
    carrierProgress.progress.set(extra, { ...progress, progress: 'delivered' });

    const result = await list.execute(context, {});

    if (!result.ok) throw new Error(result.error.code);
    expect(carrierProgress.calls).toEqual([[booked.sellerOrderId, pickup.sellerOrderId]]);
    expect(events).toEqual(['unit-open', 'unit-closed', 'carrier-progress']);
    expect(result.value.carrierProgressAvailable).toBe(true);
    expect(result.value.rows.map((row) => row.carrierProgress)).toEqual([progress, null]);
    expect(result.value.rows[0]!.carrier).toBe('Courier');
    expect(result.value.rows.map((row) => row.sellerOrderId)).not.toContain(extra);

    // Previous/Next: still one call, for the page's rows only (not the look-ahead row).
    reader.records = [booked, pickup, record()];
    carrierProgress.calls.length = 0;
    const walked = await list.execute(context, { limit: 2 });
    expect(walked.ok && walked.value.rows).toHaveLength(2);
    expect(carrierProgress.calls).toEqual([[booked.sellerOrderId, pickup.sellerOrderId]]);
  });

  it('marks the progress not available when denied or failed, and keeps the seller carrier', async () => {
    const { list, reader, labels, carrierProgress, context } = setup();
    const row = record({
      readyAt: T0,
      fulfilment: 'shipped',
      carrier: 'Courier',
      trackingRef: 'T-1',
    });
    reader.records = [row];
    labels.stores.set(row.sellerId, 'Halal Corner');
    carrierProgress.progress.set(row.sellerOrderId, {
      progress: 'booked',
      carrierStatus: 'SCHEDULED',
      updatedAt: T0,
      proofOfDelivery: false,
      fleet: 'mondapac_drive',
    });

    carrierProgress.denied = true;
    const denied = await list.execute(context, {});
    carrierProgress.denied = false;
    carrierProgress.fail = true;
    const failed = await list.execute(context, {});

    for (const result of [denied, failed]) {
      if (!result.ok) throw new Error(result.error.code);
      expect(result.value.carrierProgressAvailable).toBe(false);
      expect(result.value.rows[0]).toMatchObject({
        carrierProgress: null,
        carrier: 'Courier',
        trackingRef: 'T-1',
        storeName: 'Halal Corner',
      });
    }
  });

  it('makes no progress call for an empty page', async () => {
    const { list, carrierProgress, context } = setup();
    const result = await list.execute(context, {});
    expect(result.ok && result.value.carrierProgressAvailable).toBe(true);
    expect(carrierProgress.calls).toEqual([]);
  });

  it('places each seller order on one stage', () => {
    expect(shipmentStage(record())).toBe('to-prepare');
    expect(shipmentStage(record({ readyAt: T0 }))).toBe('ready');
    expect(shipmentStage(record({ readyAt: T0, fulfilment: 'shipped' }))).toBe('shipped');
    expect(shipmentStage(record({ fulfilment: 'delivered' }))).toBe('delivered');
    // Refunded in full before it was shipped (an admin cancellation), ready or not.
    const all = { amount: 1500n, currency };
    expect(shipmentStage(record({ refunded: all }))).toBe('refunded');
    expect(shipmentStage(record({ readyAt: T0, refunded: all }))).toBe('refunded');
    expect(shipmentStage(record({ refunded: { amount: 500n, currency } }))).toBe('to-prepare');
    expect(shipmentStage(record({ fulfilment: 'delivered', refunded: all }))).toBe('delivered');
    expect(shipmentRowActions(record())).toEqual(['view-order']);
  });
});
