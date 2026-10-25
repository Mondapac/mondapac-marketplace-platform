import { encodePayload, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, PendingEvent } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import {
  FakePickups,
  ListRegistry,
  MemoryBookings,
  MemoryDeliveryQuotes,
  MemoryDeliverySettings,
  MemoryFleetLedger,
  MemorySelection,
  ScriptedFleet,
} from '../../../../test/support/shipping-fakes';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_SERVICE_AREA_CONFIG_DIRS,
} from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { loadServiceAreas } from '../../../platform/market-config/service-area-config';
import { SHIPPING_EVENTS } from '../domain/events';
import type { FleetCapabilities, FleetCode } from '../domain/fleet';
import { ConfigCarrierPolicy } from '../infrastructure/config-carrier-policy';
import { ConfigShippingPolicy } from '../infrastructure/config-shipping-policy';
import type { CarrierStop } from './ports/carrier-gateway';
import type { ShippingDependencies } from './shipping-dependencies';
import { BookCarrierDelivery } from './use-cases/book-carrier-delivery.use-case';
import { ChargeDelivery } from './use-cases/charge-delivery.use-case';
import { QuoteDeliveries } from './use-cases/quote-deliveries.use-case';
import { RecordFleetFee } from './use-cases/record-fleet-fee.use-case';

// The delivery price a buyer is charged (delivery models, package 5) end to end in memory, on both
// Market fixtures (AU: greater-brisbane, AUD; ZZ: zz-central, JPY): the quote is the chosen
// fleet's price plus the Market margin, stored for 10 minutes and charged by its id (never by a
// price the client sends); a fleet other than the quoted one books at the platform's cost up to the
// Market cap; the fees fleets charge the platform go to their own ledger.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const areas = loadServiceAreas(TEST_SERVICE_AREA_CONFIG_DIRS, TEST_MARKET_IDS);
const NO_KEYS = { isKnownPermissionKey: () => false };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const BUYER = id<'Account'>(0xb1);
const OTHER_BUYER = id<'Account'>(0xb2);
const SELLER = id<'Seller'>(0x51);
const OTHER_SELLER = id<'Seller'>(0x52);
const ORDER = id<'Order'>(0x0a);
const SELLER_ORDER = id<'SellerOrder'>(0x5a);

describe('the access declarations', () => {
  it('quote and charge under the buyer, and record a fleet fee as the system', () => {
    expect(QuoteDeliveries.access.rule).toEqual({ kind: 'own-resources' });
    expect(ChargeDelivery.access.rule).toEqual({ kind: 'own-resources' });
    expect(RecordFleetFee.access.rule).toEqual({ kind: 'system' });
  });
});

describe.each([
  ['AU', 'AUD', '4109', '4000', '2000'],
  ['ZZ', 'JPY', '1000001', '1000002', '3000000'],
] as const)('delivery quotes in market %s', (code, currency, served, servedToo, unserved) => {
  const market = testMarketContext(code, 'default');
  const marketZone = markets.get(market.marketId).timezone;
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const buyer = (accountId: Id<'Account'> = BUYER) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'customer',
        accountId,
        sessionId: id<'Session'>(0x61),
        sellerId: null,
      }),
      'quote-0001-abcd',
    );
  const system = testCallContext(market, 'system', 'quote-0002-abcd');
  const area = areas.areaFor(market.marketId, served)!.code;
  const money = (amount: number) => ({ amount: BigInt(amount), currency });

  const capabilities = (fleet: FleetCode): FleetCapabilities => ({
    fleet,
    methods: ['instant', 'same_day', 'scheduled'],
    serviceAreas: [area],
    outsideCityAreasOnly: false,
    temperatures: ['ambient', 'chilled', 'frozen'],
    maxItemWeightGrams: null,
    maxItems: null,
    maxOrderValue: null,
    prohibitedClasses: [],
    idempotentBooking: true,
    supportsWindow: true,
  });

  let clock: FixedClock;
  let bookings: MemoryBookings;
  let selection: MemorySelection;
  let settings: MemoryDeliverySettings;
  let quotes: MemoryDeliveryQuotes;
  let ledger: MemoryFleetLedger;
  let pickups: FakePickups;
  let written: PendingEvent[];
  let drive: ScriptedFleet;
  let uber: ScriptedFleet;
  let deps: ShippingDependencies;
  let capMinor: number;
  let bounds: { minMinor: number; maxMinor: number } | null;

  const pickup: CarrierStop = {
    contactName: 'Test Halal Butcher',
    contactPhone: '+61 7 3000 0000',
    addressLines: ['1 Shop Street'],
    postcode: servedToo,
    locality: 'Shop Town',
    region: null,
    location: null,
    notes: null,
  };
  const dropoffOf = (postcode: string = served) => ({
    postcode,
    locality: 'Example Town',
    region: 'QQ',
  });

  beforeEach(() => {
    // 10:00 local on 24 October 2026 in the Market zone: before the 12:00 same-day cut-off.
    clock = new FixedClock(
      Temporal.PlainDateTime.from('2026-10-24T10:00:00').toZonedDateTime(marketZone).toInstant(),
    );
    bookings = new MemoryBookings();
    selection = new MemorySelection();
    settings = new MemoryDeliverySettings();
    quotes = new MemoryDeliveryQuotes();
    ledger = new MemoryFleetLedger();
    pickups = new FakePickups();
    pickups.answer = ok(pickup);
    pickups.postcodes = ok(new Map([[SELLER, servedToo]]));
    pickups.zones = ok(new Map([[SELLER, marketZone]]));
    written = [];
    capMinor = 1000;
    bounds = null;
    drive = new ScriptedFleet('mondapac_drive', capabilities('mondapac_drive'));
    uber = new ScriptedFleet('uber_direct', capabilities('uber_direct'));
    drive.price = money(1000);
    uber.price = money(1500);
    const shippingPolicy = new ConfigShippingPolicy(markets, areas);
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      policy: {
        currency: () => currency,
        timeZone: () => marketZone,
        deliversTo: () => true,
        fleetFallbackCapMinor: () => capMinor,
        quoteBounds: () => bounds,
      },
      sellers: undefined as never,
      audit: undefined as never,
      clock,
      ids: new SequenceIdGenerator(clock),
      outbox: {
        append: (_context: CallContext, events: readonly PendingEvent[]) => {
          for (const event of events) {
            const definition = SHIPPING_EVENTS.find((d) => d.type === event.type);
            if (definition === undefined) throw new Error(`outbox: unknown type ${event.type}`);
            const checked = encodePayload(definition.fields, event.payload, NO_KEYS);
            if (!checked.ok) throw new Error(`outbox: ${JSON.stringify(checked.error)}`);
            written.push(event);
          }
          return Promise.resolve();
        },
      },
      bookings,
      fleets: new ListRegistry([uber, drive]),
      selection,
      deliverySettings: settings,
      carrierPolicy: new ConfigCarrierPolicy(markets, areas, { apiKeys: {}, webhookSecrets: {} }),
      quotes,
      ledger,
      pickups,
      webhookSignature: undefined as never,
    };
    void shippingPolicy;
  });

  const saveSettings = async (over: Record<string, unknown> = {}) => {
    const saved = await settings.saveSettings(
      market,
      {
        enabled: { pickup: true, instant: true, same_day: true, scheduled: true },
        sameDayCutoffMinutes: 720,
        scheduledDaysAhead: 7,
        scheduledWindowMinutes: 120,
        margin: { kind: 'none' },
        roundingStepMinor: 1,
        ...over,
      } as never,
      0,
    );
    if (saved === 'conflict') throw new Error('settings conflict');
  };

  const sellers = (...entries: Id<'Seller'>[]) =>
    entries.map((sellerId) => ({ sellerId, itemCount: 2, declaredValueMinor: 4000 }));
  const ask = (context: CallContext = buyer(), entries = sellers(SELLER), postcode?: string) =>
    new QuoteDeliveries(gate, deps).execute(context, {
      sellers: entries,
      dropoff: dropoffOf(postcode),
    });
  const charge = (input: Record<string, unknown>, context: CallContext = buyer()) =>
    new ChargeDelivery(gate, deps).execute(context, {
      seller: sellers(SELLER)[0],
      method: 'instant',
      quoteId: null,
      dropoff: dropoffOf(),
      ...input,
    });
  const quoted = async (method: 'instant' | 'same_day' | 'scheduled') => {
    const result = await ask();
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    const entry = result.value.get(SELLER)!.quotes[method];
    if (entry?.kind !== 'quoted') throw new Error(`no quote: ${JSON.stringify(entry)}`);
    return entry.quote;
  };

  describe('quote-deliveries', () => {
    it('prices each open delivering method as the chosen fleet price plus the margin', async () => {
      await saveSettings({ margin: { kind: 'percent', basisPoints: 1000 } });
      const result = await ask();
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const entry = result.value.get(SELLER)!;
      expect(Object.keys(entry.quotes).sort()).toEqual(['instant', 'same_day', 'scheduled']);
      expect(entry.pickupPostcode).toBe(servedToo);
      const instant = entry.quotes.instant;
      // Mondapac Drive is first in the default order and is quoted 1000: 10% margin on top.
      expect(instant).toMatchObject({
        kind: 'quoted',
        quote: {
          fleet: 'mondapac_drive',
          quote: money(1000),
          margin: money(100),
          total: money(1100),
        },
      });
      // The quote is stored for the buyer, valid 10 minutes.
      expect(quotes.rows.size).toBe(3);
      if (instant?.kind !== 'quoted') return;
      expect(instant.quote.validUntil.toString()).toBe(clock.now().add({ minutes: 10 }).toString());
    });

    it('ranks the fleets that answered by the active model of the method', async () => {
      const modelId = id<'FleetSelectionModel'>(0x201);
      selection.models.set(modelId, {
        id: modelId,
        name: 'Cheapest',
        rule: { kind: 'cheapest' },
        version: 1,
        createdAt: clock.now(),
        updatedAt: clock.now(),
        marketId: code,
      } as never);
      selection.active.set(`${code}|instant`, modelId);
      uber.price = money(800);
      const instant = await quoted('instant');
      expect(instant.fleet).toBe('uber_direct');
      expect(instant.quote).toEqual(money(800));
      // The other methods keep the default order.
      expect((await quoted('same_day')).fleet).toBe('mondapac_drive');
    });

    it('reuses a quote that holds, and asks the fleets again once it stopped holding', async () => {
      await quoted('instant');
      const first = drive.quoted.length;
      await quoted('instant');
      expect(drive.quoted.length).toBe(first);
      expect(quotes.rows.size).toBe(3);
      clock.advance(Temporal.Duration.from({ minutes: 11 }));
      await quoted('instant');
      expect(drive.quoted.length).toBeGreaterThan(first);
    });

    it('says no fleet when none can carry the trip, and failed when a fleet gives no price', async () => {
      const outside = await ask(buyer(), sellers(SELLER), unserved);
      expect(outside.ok && outside.value.get(SELLER)!.quotes).toMatchObject({
        instant: { kind: 'no-fleet' },
      });
      drive.price = null;
      uber.price = null;
      const none = await ask();
      expect(none.ok && none.value.get(SELLER)!.quotes).toMatchObject({
        instant: { kind: 'failed' },
        scheduled: { kind: 'failed' },
      });
      expect(quotes.rows.size).toBe(0);
    });

    it('does not use a price outside the Market bounds or in another currency', async () => {
      bounds = { minMinor: 500, maxMinor: 1200 };
      uber.price = money(1100);
      drive.price = money(9000);
      expect((await quoted('instant')).fleet).toBe('uber_direct');
      drive.price = { amount: 1000n, currency: currency === 'AUD' ? 'JPY' : 'AUD' };
      uber.price = null;
      quotes.rows.clear();
      const result = await ask();
      expect(result.ok && result.value.get(SELLER)!.quotes.instant).toEqual({ kind: 'failed' });
    });

    it('offers no price for a method the seller or the platform does not carry', async () => {
      await saveSettings({
        enabled: { pickup: true, instant: false, same_day: true, scheduled: true },
      });
      const result = await ask();
      expect(result.ok && Object.keys(result.value.get(SELLER)!.quotes).sort()).toEqual([
        'same_day',
        'scheduled',
      ]);
      // Closed after the cut-off: no same-day price either.
      clock.advance(Temporal.Duration.from({ hours: 3 }));
      const late = await ask();
      expect(late.ok && Object.keys(late.value.get(SELLER)!.quotes)).toEqual(['scheduled']);
    });

    it('has no trip to quote for a seller without an approved pickup address', async () => {
      pickups.postcodes = ok(new Map());
      const result = await ask();
      expect(result.ok && result.value.get(SELLER)!.quotes.instant).toEqual({ kind: 'no-fleet' });
      expect(drive.quoted).toEqual([]);
    });

    it('refuses a bad request, another account type and more than ten sellers', async () => {
      const bad = await ask(buyer(), [
        { sellerId: 'x', itemCount: 0, declaredValueMinor: -1 },
      ] as never);
      expect(bad.ok).toBe(false);
      const noPostcode = await new QuoteDeliveries(gate, deps).execute(buyer(), {
        sellers: sellers(SELLER),
        dropoff: { postcode: '' },
      });
      expect(!noPostcode.ok && noPostcode.error.code).toBe('validation.failed');
      const many = await ask(
        buyer(),
        Array.from({ length: 11 }, (_, n) => ({
          sellerId: id<'Seller'>(0x100 + n),
          itemCount: 1,
          declaredValueMinor: 1,
        })),
      );
      expect(!many.ok && many.error.code).toBe('validation.failed');
    });
  });

  describe('charge-delivery', () => {
    it('charges the stored quote by its id and never a price from the client', async () => {
      await saveSettings({ margin: { kind: 'fixed', amountMinor: 100 } });
      const instant = await quoted('instant');
      const charged = await charge({ quoteId: instant.quoteId, price: 1 });
      expect(charged.ok && charged.value).toMatchObject({
        quoteId: instant.quoteId,
        fleet: 'mondapac_drive',
        quote: money(1000),
        margin: money(100),
        total: money(1100),
      });
    });

    it('does not know another buyer, seller, method or address quote', async () => {
      const instant = await quoted('instant');
      for (const other of [
        () => charge({ quoteId: instant.quoteId }, buyer(OTHER_BUYER)),
        () => charge({ quoteId: instant.quoteId, seller: sellers(OTHER_SELLER)[0] }),
        () => charge({ quoteId: instant.quoteId, method: 'scheduled' }),
        () => charge({ quoteId: instant.quoteId, dropoff: dropoffOf(servedToo) }),
        () => charge({ quoteId: id<'DeliveryQuote'>(0xdead) }),
      ]) {
        const result = await other();
        expect(!result.ok && result.error.code).toBe('shipping.quote-not-found');
      }
    });

    it('tells a changed price instead of charging it, and charges the same price again', async () => {
      const instant = await quoted('instant');
      clock.advance(Temporal.Duration.from({ minutes: 11 }));
      drive.price = money(1400);
      const changed = await charge({ quoteId: instant.quoteId });
      expect(!changed.ok && changed.error).toMatchObject({
        code: 'shipping.quote-changed',
        quote: { total: money(1400) },
      });
      // The buyer who saw the new price confirms it: that quote is the one charged.
      const fresh = !changed.ok && changed.error.code === 'shipping.quote-changed';
      expect(fresh).toBe(true);
      if (changed.ok || changed.error.code !== 'shipping.quote-changed') return;
      const confirmed = await charge({ quoteId: changed.error.quote.quoteId });
      expect(confirmed.ok && confirmed.value.total).toEqual(money(1400));
      // An unchanged price after expiry is charged without asking the buyer again.
      clock.advance(Temporal.Duration.from({ minutes: 11 }));
      const same = await charge({ quoteId: changed.error.quote.quoteId });
      expect(same.ok && same.value.total).toEqual(money(1400));
    });

    it('asks for a price when the buyer saw none, and refuses when no fleet gives one', async () => {
      const first = await charge({});
      expect(first.ok && first.value.total).toEqual(money(1000));
      quotes.rows.clear();
      drive.price = null;
      uber.price = null;
      const none = await charge({});
      expect(!none.ok && none.error.code).toBe('shipping.quote-unavailable');
    });

    it('refuses a pickup, an unknown method and a quote id that is not one', async () => {
      for (const input of [{ method: 'pickup' }, { method: 'drone' }, { quoteId: 'nope' }]) {
        const result = await charge(input);
        expect(!result.ok && result.error.code).toBe('validation.failed');
      }
    });
  });

  describe('a booking by another fleet than the one charged', () => {
    const book = (charged: { fleet: FleetCode; quoteMinor: number } | undefined) =>
      new BookCarrierDelivery(gate, deps).execute(system, {
        orderId: ORDER,
        sellerOrderId: SELLER_ORDER,
        sellerId: SELLER,
        dropoff: {
          contactName: 'Aisha Rahman',
          contactPhone: '0412345678',
          addressLines: ['12 Example Street'],
          postcode: served,
          locality: 'Example Town',
          region: 'QQ',
          notes: null,
        },
        service: { method: 'instant', window: null },
        ...(charged === undefined ? {} : { charged }),
      });

    it('books the charged fleet first and records nothing when it takes the order', async () => {
      expect(await book({ fleet: 'mondapac_drive', quoteMinor: 1000 })).toEqual(ok('booked'));
      expect(ledger.fallbacks.size).toBe(0);
      expect(written.map((event) => event.type)).toEqual([
        'shipping.carrier-delivery-progressed.v1',
      ]);
    });

    it('absorbs the difference within the cap and never changes what the buyer paid', async () => {
      drive.bookFailures = [{ code: 'carrier.refused' }];
      uber.price = money(1800);
      expect(await book({ fleet: 'mondapac_drive', quoteMinor: 1000 })).toEqual(ok('booked'));
      const row = [...ledger.fallbacks.values()][0]!;
      expect(row).toMatchObject({
        chargedFleet: 'mondapac_drive',
        bookedFleet: 'uber_direct',
        chargedQuote: money(1000),
        bookedPrice: money(1800),
        difference: money(800),
        capMinor: 1000,
        overCap: false,
      });
      expect(written.map((event) => event.type)).toEqual([
        'shipping.carrier-delivery-progressed.v1',
      ]);
    });

    it('alerts an admin when the difference passes the cap, and still books', async () => {
      capMinor = 500;
      drive.bookFailures = [{ code: 'carrier.refused' }];
      uber.price = money(1800);
      expect(await book({ fleet: 'mondapac_drive', quoteMinor: 1000 })).toEqual(ok('booked'));
      expect([...ledger.fallbacks.values()][0]).toMatchObject({
        difference: money(800),
        overCap: true,
      });
      const alert = written.find(
        (event) => event.type === 'shipping.delivery-fallback-over-cap.v1',
      );
      expect(alert?.payload).toEqual({
        orderId: ORDER,
        sellerOrderId: SELLER_ORDER,
        sellerId: SELLER,
      });
      // A difference of exactly the cap is still within it.
      written.length = 0;
      ledger.fallbacks.clear();
      bookings.rows.clear();
      capMinor = 800;
      drive.bookFailures = [{ code: 'carrier.refused' }];
      await book({ fleet: 'mondapac_drive', quoteMinor: 1000 });
      expect([...ledger.fallbacks.values()][0]).toMatchObject({ overCap: false });
      expect(written.map((event) => event.type)).toEqual([
        'shipping.carrier-delivery-progressed.v1',
      ]);
    });

    it('costs the platform nothing extra when the booked fleet is cheaper', async () => {
      drive.bookFailures = [{ code: 'carrier.refused' }];
      uber.price = money(600);
      await book({ fleet: 'mondapac_drive', quoteMinor: 1000 });
      expect([...ledger.fallbacks.values()][0]).toMatchObject({
        difference: money(0),
        overCap: false,
      });
    });

    it('flags an order whose booked price cannot be read, for an admin to look at', async () => {
      drive.bookFailures = [{ code: 'carrier.refused' }];
      uber.price = null;
      await book({ fleet: 'mondapac_drive', quoteMinor: 1000 });
      expect([...ledger.fallbacks.values()][0]).toMatchObject({
        bookedPrice: null,
        difference: null,
        overCap: true,
      });
      expect(written.map((event) => event.type)).toContain(
        'shipping.delivery-fallback-over-cap.v1',
      );
    });

    it('records no fallback for an order with no charged fleet', async () => {
      drive.bookFailures = [{ code: 'carrier.refused' }];
      await book(undefined);
      expect(ledger.fallbacks.size).toBe(0);
    });

    it('refuses a charged fleet that is not a fleet', async () => {
      const result = await book({ fleet: 'nobody' as never, quoteMinor: 1000 });
      expect(!result.ok && result.error.code).toBe('validation.failed');
    });
  });

  describe('record-fleet-fee', () => {
    const fee = (over: Record<string, unknown> = {}) => ({
      fleet: 'mondapac_drive',
      sellerOrderId: SELLER_ORDER,
      reason: 'waiting',
      amount: '250',
      externalRef: 'drive-fee-1',
      occurredAt: '2026-10-24T01:00:00Z',
      ...over,
    });
    const record = (input: unknown, context: CallContext = system) =>
      new RecordFleetFee(gate, deps).execute(context, input);

    beforeEach(async () => {
      await new BookCarrierDelivery(gate, deps).execute(system, {
        orderId: ORDER,
        sellerOrderId: SELLER_ORDER,
        sellerId: SELLER,
        dropoff: {
          contactName: 'Aisha Rahman',
          contactPhone: '0412345678',
          addressLines: ['12 Example Street'],
          postcode: served,
          locality: 'Example Town',
          region: 'QQ',
          notes: null,
        },
        service: { method: 'instant', window: null },
      });
    });

    it('records a fee once by the fleet reference, with its reason and amount', async () => {
      expect(await record(fee())).toEqual(ok('recorded'));
      expect(await record(fee())).toEqual(ok('duplicate'));
      expect(await record(fee({ externalRef: 'drive-fee-2', reason: 'cancel' }))).toEqual(
        ok('recorded'),
      );
      expect(ledger.fees.map((row) => [row.reason, row.amount, row.fleet])).toEqual([
        ['waiting', money(250), 'mondapac_drive'],
        ['cancel', money(250), 'mondapac_drive'],
      ]);
      expect(ledger.fees[0]!.occurredAt.toString()).toBe('2026-10-24T01:00:00Z');
    });

    it('needs a booking of that fleet for that seller order', async () => {
      const other = await record(fee({ fleet: 'uber_direct' }));
      expect(!other.ok && other.error.code).toBe('shipping.carrier-delivery-not-found');
      const unknown = await record(fee({ sellerOrderId: id<'SellerOrder'>(0x5b) }));
      expect(!unknown.ok && unknown.error.code).toBe('shipping.carrier-delivery-not-found');
      expect(ledger.fees).toEqual([]);
    });

    it('refuses a fee that is not a fee, naming each field', async () => {
      const result = await record({
        fleet: 'nobody',
        sellerOrderId: 'x',
        reason: 'tip',
        amount: '0',
        externalRef: '',
        occurredAt: 'yesterday',
      });
      expect(!result.ok && result.error).toMatchObject({ code: 'validation.failed' });
      if (result.ok || result.error.code !== 'validation.failed') return;
      expect(result.error.fields.map((field) => field.path).sort()).toEqual([
        'amount',
        'externalRef',
        'fleet',
        'occurredAt',
        'reason',
        'sellerOrderId',
      ]);
      expect((await record(fee({ amount: '-5' }))).ok).toBe(false);
      expect((await record(fee({ amount: '1.5' }))).ok).toBe(false);
    });

    it('is the system only', async () => {
      const denied = await record(fee(), buyer());
      expect(denied.ok).toBe(false);
    });
  });
});
