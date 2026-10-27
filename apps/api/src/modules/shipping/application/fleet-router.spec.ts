import { encodePayload, err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, PendingEvent } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import {
  FakePickups,
  ListRegistry,
  MemoryBookings,
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
import type { CarrierMethod } from '../domain/booking-service';
import type { FleetCapabilities, FleetCode } from '../domain/fleet';
import type { FleetSelectionModel, SelectionRule } from '../domain/fleet-selection';
import { SHIPPING_EVENTS } from '../domain/events';
import { ConfigCarrierPolicy } from '../infrastructure/config-carrier-policy';
import { FakeTestCarrier } from '../infrastructure/fake-test-carrier';
import { capabilitiesOf } from '../infrastructure/fleet-config';
import type { CarrierStop } from './ports/carrier-gateway';
import type { ShippingDependencies } from './shipping-dependencies';
import { BookCarrierDelivery } from './use-cases/book-carrier-delivery.use-case';
import { CancelCarrierDelivery } from './use-cases/cancel-carrier-delivery.use-case';

// The fleet router end to end in memory, on both Market fixtures (AU: greater-brisbane, AUD; ZZ:
// zz-central, JPY): the capability filter, the ranking by the active model of the method, the
// fallbacks, and the rule for a fleet that cannot dedupe a booking.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const areas = loadServiceAreas(TEST_SERVICE_AREA_CONFIG_DIRS, TEST_MARKET_IDS);
const T0 = Temporal.Instant.from('2026-10-24T10:00:00Z');
const NO_KEYS = { isKnownPermissionKey: () => false };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ORDER = id<'Order'>(0x0a);
const SELLER_ORDER = id<'SellerOrder'>(0x5a);
const SELLER = id<'Seller'>(0x51);
const MODEL = id<'FleetSelectionModel'>(0x201);

describe.each([
  ['AU', 'AUD', '4109', '4000'],
  ['ZZ', 'JPY', '1000001', '1000002'],
] as const)('the fleet router in market %s', (code, currency, served, servedToo) => {
  const market = testMarketContext(code, 'default');
  const system = testCallContext(market, 'system', 'router-0001-abcd');
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const area = areas.areaFor(market.marketId, served)!.code;
  // A postcode in no ServiceArea of the Market at all.
  const outside = code === 'AU' ? '2000' : '3000000';

  const capabilities = (
    fleet: FleetCode,
    overrides: Partial<FleetCapabilities> = {},
  ): FleetCapabilities => ({
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
    ...overrides,
  });
  const money = (amount: number) => ({ amount: BigInt(amount), currency });

  let bookings: MemoryBookings;
  let selection: MemorySelection;
  let registry: ListRegistry;
  let pickups: FakePickups;
  let written: PendingEvent[];
  let deps: ShippingDependencies;
  let drive: ScriptedFleet;
  let uber: ScriptedFleet;
  let zoom: ScriptedFleet;
  let post: ScriptedFleet;

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
  const dropoff = (postcode: string = served) => ({
    contactName: 'Aisha Rahman',
    contactPhone: '0412345678',
    addressLines: ['12 Example Street'],
    postcode,
    locality: 'Example Town',
    region: 'QQ',
    notes: null,
  });
  const model = (rule: SelectionRule, name = 'A model'): FleetSelectionModel => ({
    id: MODEL,
    name,
    rule,
    version: 1,
    createdAt: T0,
    updatedAt: T0,
  });
  const activate = (rule: SelectionRule, method: CarrierMethod = 'instant') => {
    selection.models.set(MODEL, { ...model(rule), marketId: code });
    selection.active.set(`${code}|${method}`, MODEL);
  };

  beforeEach(() => {
    const clock = new FixedClock(T0);
    bookings = new MemoryBookings();
    selection = new MemorySelection();
    pickups = new FakePickups();
    pickups.answer = ok(pickup);
    written = [];
    drive = new ScriptedFleet('mondapac_drive', capabilities('mondapac_drive'));
    uber = new ScriptedFleet('uber_direct', capabilities('uber_direct'));
    zoom = new ScriptedFleet('zoom2u', capabilities('zoom2u'));
    post = new ScriptedFleet(
      'auspost',
      capabilities('auspost', {
        methods: ['scheduled'],
        serviceAreas: [],
        outsideCityAreasOnly: true,
        temperatures: ['ambient'],
      }),
    );
    registry = new ListRegistry([post, zoom, uber, drive]);
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      fees: undefined as never,
      policy: {
        currency: () => currency,
        timeZone: () => 'Australia/Brisbane',
        deliversTo: () => true,
      },
      sellers: undefined as never,
      stores: undefined as never,
      audit: undefined as never,
      clock,
      ids: new SequenceIdGenerator(clock),
      outbox: {
        append: (_context: CallContext, events: readonly PendingEvent[]) => {
          for (const event of events) {
            const definition = SHIPPING_EVENTS.find((d) => d.type === event.type)!;
            const checked = encodePayload(definition.fields, event.payload, NO_KEYS);
            if (!checked.ok) throw new Error('outbox');
            written.push(event);
          }
          return Promise.resolve();
        },
      },
      bookings,
      fleets: registry,
      selection,
      deliverySettings: undefined as never,
      carrierPolicy: new ConfigCarrierPolicy(markets, areas, { apiKeys: {}, webhookSecrets: {} }),
      pickups,
      webhookSignature: undefined as never,
      securityEvents: undefined as never,
    };
  });

  const book = (
    overrides: Record<string, unknown> = {},
    method: CarrierMethod = 'instant',
    window: { start: string; end: string } | null = null,
  ) =>
    new BookCarrierDelivery(gate, deps).execute(system, {
      orderId: ORDER,
      sellerOrderId: SELLER_ORDER,
      sellerId: SELLER,
      dropoff: dropoff(),
      service: { method, window },
      ...overrides,
    });
  const bookedBy = () => [...bookings.rows.values()][0]?.fleet;
  const asked = () =>
    [post, zoom, uber, drive].filter((f) => f.calls.includes('book')).map((f) => f.fleet);

  describe('with no model active', () => {
    it('books the platform fleet first, and records which fleet booked', async () => {
      expect(await book()).toEqual(ok('booked'));
      expect(bookedBy()).toBe('mondapac_drive');
      expect(asked()).toEqual(['mondapac_drive']);
      // A fixed list needs no quote.
      expect([drive, uber, zoom].flatMap((f) => f.quoted)).toEqual([]);
      expect(written).toHaveLength(1);
    });

    it('falls back in the default order: Uber Direct, then Zoom2u', async () => {
      drive.bookFailures = [{ code: 'carrier.refused' }];
      expect(await book()).toEqual(ok('booked'));
      expect(bookedBy()).toBe('uber_direct');

      bookings.rows.clear();
      drive.bookFailures = [{ code: 'carrier.not-configured' }];
      uber.bookFailures = [{ code: 'carrier.refused' }];
      expect(await book()).toEqual(ok('booked'));
      expect(bookedBy()).toBe('zoom2u');
    });

    it('sends each fleet the booking with the stops and the parcel it needs', async () => {
      await book({ parcel: { itemCount: 4, declaredValueMinor: 7500, weightGrams: 3000 } });
      expect(drive.booked[0]).toMatchObject({
        externalReference: SELLER_ORDER,
        pickup,
        dropoff: { postcode: served, locality: 'Example Town', region: 'QQ', location: null },
        parcel: { weightGrams: 3000, itemCount: 4, declaredValue: money(7500) },
        method: 'instant',
        mode: 'on_demand',
        window: null,
      });
    });
  });

  describe('the capability filter', () => {
    it('skips a fleet that is off for the Market (no capabilities)', async () => {
      drive.declared = null;
      await book();
      expect(asked()).toEqual(['uber_direct']);
    });

    it('asks no fleet and answers no-carrier when none can carry the order', async () => {
      for (const fleet of [drive, uber, zoom]) fleet.declared = null;
      expect(await book()).toEqual(ok('no-carrier'));
      // The only fleet left carries scheduled drop-offs outside the city areas.
      expect(await book()).toEqual(ok('no-carrier'));
      expect(post.calls).toEqual([]);
      expect(bookings.rows.size).toBe(0);
    });

    it('skips a fleet that does not carry the method', async () => {
      drive.declared = capabilities('mondapac_drive', { methods: ['scheduled'] });
      await book();
      expect(asked()).toEqual(['uber_direct']);
    });

    it('skips a fleet that cannot be booked for a buyer window', async () => {
      drive.declared = capabilities('mondapac_drive', { supportsWindow: false });
      const window = { start: '2026-10-26T01:00:00Z', end: '2026-10-26T03:00:00Z' };
      await book({}, 'scheduled', window);
      expect(asked()).toEqual(['uber_direct']);
    });

    it('skips a fleet whose areas miss either end of the trip', async () => {
      drive.declared = capabilities('mondapac_drive', { serviceAreas: ['elsewhere'] });
      await book();
      expect(asked()).toEqual(['uber_direct']);
    });

    it('sends a drop-off outside every city area to the fleet that serves those, and only it', async () => {
      const window = { start: '2026-10-26T01:00:00Z', end: '2026-10-26T03:00:00Z' };
      expect(await book({ dropoff: dropoff(outside) }, 'scheduled', window)).toEqual(ok('booked'));
      expect(bookedBy()).toBe('auspost');
      expect(asked()).toEqual(['auspost']);
    });

    it('skips a fleet that refuses the temperature, weight, item count, value or class', async () => {
      drive.declared = capabilities('mondapac_drive', { temperatures: ['ambient'] });
      uber.declared = capabilities('uber_direct', { maxItemWeightGrams: 1000 });
      zoom.declared = capabilities('zoom2u', { maxItems: 2 });
      await book({ parcel: { temperature: 'chilled', weightGrams: 5000, itemCount: 3 } });
      expect(asked()).toEqual([]);

      uber.declared = capabilities('uber_direct');
      zoom.declared = capabilities('zoom2u');
      drive.declared = capabilities('mondapac_drive', { maxOrderValue: money(5000) });
      expect(await book({ parcel: { declaredValueMinor: 5001 } })).toEqual(ok('booked'));
      expect(bookedBy()).toBe('uber_direct');

      bookings.rows.clear();
      uber.declared = capabilities('uber_direct', { prohibitedClasses: ['alcohol'] });
      zoom.declared = null;
      expect(await book({ parcel: { classes: ['alcohol'], declaredValueMinor: 100 } })).toEqual(
        ok('booked'),
      );
      expect(bookedBy()).toBe('mondapac_drive');
      expect(uber.booked).toHaveLength(1);
    });
  });

  describe('the active model', () => {
    beforeEach(() => {
      drive.price = money(1400);
      drive.etaMinutes = 60;
      uber.price = money(1000);
      uber.etaMinutes = 90;
      zoom.price = money(1200);
      zoom.etaMinutes = 20;
    });

    it('ranks by the lowest quote under cheapest, and quotes only capable fleets', async () => {
      post.declared = capabilities('auspost');
      activate({ kind: 'cheapest' });
      await book();
      expect(bookedBy()).toBe('uber_direct');
      expect(post.quoted.length).toBe(1);
      // The quote sees postcodes and saved-address places, never names or phones.
      expect(drive.quoted[0]).toEqual({
        pickup: { postcode: servedToo, locality: 'Shop Town', region: null },
        dropoff: { postcode: served, locality: 'Example Town', region: 'QQ' },
        parcel: expect.objectContaining({ itemCount: 1 }) as unknown,
        method: 'instant',
        mode: 'on_demand',
      });
    });

    it('gives a tie in price to the platform fleet', async () => {
      uber.price = money(1400);
      zoom.price = money(1400);
      activate({ kind: 'cheapest' });
      await book();
      expect(bookedBy()).toBe('mondapac_drive');
    });

    it('scores price, ETA and the admin-set reliability under weighted', async () => {
      activate({ kind: 'weighted', weights: { price: 0, eta: 1, reliability: 0 } });
      await book();
      expect(bookedBy()).toBe('zoom2u');

      bookings.rows.clear();
      selection.scores.set(`${code}|mondapac_drive`, 100);
      selection.scores.set(`${code}|zoom2u`, 0);
      activate({ kind: 'weighted', weights: { price: 0, eta: 0, reliability: 1 } });
      await book();
      expect(bookedBy()).toBe('mondapac_drive');
    });

    it('follows the list under fixed_priority, with no quotes', async () => {
      activate({ kind: 'fixed_priority', order: ['zoom2u', 'mondapac_drive'] });
      await book();
      expect(bookedBy()).toBe('zoom2u');
      expect([drive, uber, zoom].flatMap((f) => f.quoted)).toEqual([]);

      // A fleet left off the list is never used, even when it is the only one that could.
      bookings.rows.clear();
      zoom.declared = null;
      drive.declared = null;
      expect(await book()).toEqual(ok('no-carrier'));
      expect(uber.calls).toEqual([]);
    });

    it('uses the model of the method: another method keeps its own', async () => {
      activate({ kind: 'cheapest' }, 'instant');
      await book({}, 'same_day');
      expect(bookedBy()).toBe('mondapac_drive');
      bookings.rows.clear();
      await book({}, 'instant');
      expect(bookedBy()).toBe('uber_direct');
    });

    it('puts a fleet that gave no quote after the quoted ones', async () => {
      drive.quoteFailure = { code: 'carrier.unavailable' };
      zoom.quoteFailure = { code: 'carrier.unauthorized' };
      activate({ kind: 'cheapest' });
      await book();
      expect(bookedBy()).toBe('uber_direct');
      uber.bookFailures = [{ code: 'carrier.refused' }];
      bookings.rows.clear();
      await book();
      // Drive comes before Zoom2u among the unquoted: the tie order.
      expect(bookedBy()).toBe('mondapac_drive');
    });
  });

  describe('when a fleet does not answer', () => {
    it('refuses nothing it can pass on: not-configured, refused and unauthorized go to the next fleet', async () => {
      drive.bookFailures = [{ code: 'carrier.unauthorized' }];
      drive.declared = capabilities('mondapac_drive', { idempotentBooking: false });
      expect(await book()).toEqual(ok('booked'));
      expect(bookedBy()).toBe('uber_direct');
      expect(bookings.attempts.size).toBe(0);
    });

    it('falls back on not-sent even from a fleet that is not idempotent: nothing reached it', async () => {
      drive.bookFailures = [{ code: 'carrier.not-sent' }];
      drive.declared = capabilities('mondapac_drive', { idempotentBooking: false });
      expect(await book()).toEqual(ok('booked'));
      expect(bookedBy()).toBe('uber_direct');
      expect(bookings.attempts.size).toBe(0);
    });

    it('answers no-carrier, not unknown, when every fleet said not-sent', async () => {
      for (const fleet of [drive, uber, zoom]) fleet.bookFailures = [{ code: 'carrier.not-sent' }];
      expect(await book()).toEqual(ok('no-carrier'));
      expect(bookings.attempts.size).toBe(0);
    });

    it('answers refused when every fleet that could carry it refused', async () => {
      for (const fleet of [drive, uber, zoom]) fleet.bookFailures = [{ code: 'carrier.refused' }];
      expect(await book()).toEqual(ok('refused'));
      expect(bookings.rows.size).toBe(0);
      expect(bookings.attempts.size).toBe(0);
    });

    it('answers no-carrier when every fleet was not configured', async () => {
      for (const fleet of [drive, uber, zoom])
        fleet.bookFailures = [{ code: 'carrier.not-configured' }];
      expect(await book()).toEqual(ok('no-carrier'));
    });

    it('retries later, with the same fleet first, when a fleet that dedupes is unavailable', async () => {
      drive.bookFailures = [{ code: 'carrier.unavailable' }];
      expect(await book()).toEqual(err({ code: 'shipping.carrier-unavailable' }));
      expect(asked()).toEqual(['mondapac_drive']);
      expect(bookings.attempts.get(`${code}|${SELLER_ORDER}`)).toBe('mondapac_drive');

      // The ranking now prefers another fleet, but the order may be booked at the first one.
      drive.price = money(9000);
      uber.price = money(100);
      activate({ kind: 'cheapest' });
      expect(await book()).toEqual(ok('booked'));
      expect(bookedBy()).toBe('mondapac_drive');
      expect(uber.calls).not.toContain('book');
      expect(bookings.attempts.size).toBe(0);
    });

    it('still falls to the next fleet when the one asked again says nothing was booked', async () => {
      drive.bookFailures = [{ code: 'carrier.unavailable' }, { code: 'carrier.refused' }];
      await book();
      expect(await book()).toEqual(ok('booked'));
      expect(bookedBy()).toBe('uber_direct');
    });

    it('never repeats a booking, nor gives it to another fleet, when a fleet that cannot dedupe goes quiet', async () => {
      drive.declared = capabilities('mondapac_drive', { idempotentBooking: false });
      drive.bookFailures = [{ code: 'carrier.unavailable' }];
      expect(await book()).toEqual(ok('unknown'));
      expect(uber.calls).toEqual([]);
      expect(zoom.calls).toEqual([]);
      expect(bookings.rows.size).toBe(0);

      // A second delivery of the same event: the answer is the same, with no call at all.
      expect(await book()).toEqual(ok('unknown'));
      expect(drive.calls.filter((call) => call === 'book')).toHaveLength(1);
      expect(uber.calls).toEqual([]);
    });

    it('treats a note about a fleet that is now off as unknown', async () => {
      bookings.attempts.set(`${code}|${SELLER_ORDER}`, 'mondapac_drive');
      drive.declared = null;
      expect(await book()).toEqual(ok('unknown'));
      expect(uber.calls).toEqual([]);
    });
  });

  describe('cancel', () => {
    const cancel = () =>
      new CancelCarrierDelivery(gate, deps).execute(system, { sellerOrderId: SELLER_ORDER });

    it('asks the fleet that holds the booking', async () => {
      drive.bookFailures = [{ code: 'carrier.refused' }];
      await book();
      expect(bookedBy()).toBe('uber_direct');
      expect(await cancel()).toEqual(ok('cancelled'));
      expect(uber.calls).toContain('cancel');
      expect(drive.calls).not.toContain('cancel');
    });

    it('reads a refusal as not-cancellable from a fleet that dedupes', async () => {
      await book();
      drive.cancelAnswer = err({ code: 'carrier.refused' });
      expect(await cancel()).toEqual(ok('not-cancellable'));
    });

    it('does not read a refusal as "still booked" from a fleet that cannot dedupe', async () => {
      drive.declared = capabilities('mondapac_drive', { idempotentBooking: false });
      await book();
      drive.cancelAnswer = err({ code: 'carrier.refused' });
      expect(await cancel()).toEqual(ok('unknown'));
      // The booking row is left as it is: only an admin can tell.
      expect([...bookings.rows.values()][0]?.progress).toBe('booked');
    });

    it('retries later on unavailable or unauthorized, whatever the fleet', async () => {
      drive.declared = capabilities('mondapac_drive', { idempotentBooking: false });
      await book();
      drive.cancelAnswer = err({ code: 'carrier.unavailable' });
      expect(await cancel()).toEqual(err({ code: 'shipping.carrier-unavailable' }));
      drive.cancelAnswer = err({ code: 'carrier.unauthorized' });
      expect(await cancel()).toEqual(err({ code: 'shipping.carrier-unavailable' }));
      drive.cancelAnswer = err({ code: 'carrier.not-sent' });
      expect(await cancel()).toEqual(err({ code: 'shipping.carrier-unavailable' }));
    });
  });
});

describe.each([['ZZ', 'JPY', '1000001', '1000002']] as const)(
  'the fake test fleet in market %s',
  (code, currency, served, servedToo) => {
    const market = testMarketContext(code, 'default');
    const system = testCallContext(market, 'system', 'router-0002-abcd');
    const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
    const policy = new ConfigCarrierPolicy(markets, areas, { apiKeys: {}, webhookSecrets: {} });

    it('is on only where the Market lists it, books deterministically and once per reference', async () => {
      const fake = new FakeTestCarrier((m) => {
        const entry = policy.fleetEntry(m.marketId, 'fake_test');
        return entry === undefined
          ? null
          : capabilitiesOf('fake_test', entry, currency, {
              idempotentBooking: true,
              supportsWindow: true,
            });
      });
      // The AU Market lists no fake fleet: never a candidate there.
      expect(fake.capabilities(testMarketContext('AU', 'default'))).toBeNull();
      expect(fake.capabilities(market)).toMatchObject({
        fleet: 'fake_test',
        serviceAreas: ['zz-central'],
      });

      const clock = new FixedClock(T0);
      const bookings = new MemoryBookings();
      const pickups = new FakePickups();
      pickups.answer = ok({
        contactName: 'Shop',
        contactPhone: '+81 3 0000 0000',
        addressLines: ['1 Shop Street'],
        postcode: servedToo,
        locality: 'Shop Town',
        region: null,
        location: null,
        notes: null,
      });
      const deps: ShippingDependencies = {
        unitOfWork: new FakeUnitOfWork(),
        fees: undefined as never,
        policy: {
          currency: () => currency,
          timeZone: () => 'Australia/Brisbane',
          deliversTo: () => true,
        },
        sellers: undefined as never,
        stores: undefined as never,
        audit: undefined as never,
        clock,
        ids: new SequenceIdGenerator(clock),
        outbox: { append: () => Promise.resolve() },
        bookings,
        fleets: new ListRegistry([fake]),
        selection: new MemorySelection(),
        deliverySettings: undefined as never,
        carrierPolicy: policy,
        pickups,
        webhookSignature: undefined as never,
        securityEvents: undefined as never,
      };
      const request = {
        orderId: ORDER,
        sellerOrderId: SELLER_ORDER,
        sellerId: SELLER,
        dropoff: {
          contactName: 'Aisha Rahman',
          contactPhone: '0412345678',
          addressLines: ['12 Example Street'],
          postcode: served,
          locality: 'Example Town',
          notes: null,
        },
        service: { method: 'same_day', window: null } as const,
      };
      expect(await new BookCarrierDelivery(gate, deps).execute(system, request)).toEqual(
        ok('booked'),
      );
      expect([...bookings.rows.values()][0]).toMatchObject({
        fleet: 'fake_test',
        carrierReference: `fake-${SELLER_ORDER}`,
      });
      expect(fake.booked).toHaveLength(1);
      expect(await new BookCarrierDelivery(gate, deps).execute(system, request)).toEqual(
        ok('already-booked'),
      );
      expect(fake.booked).toHaveLength(1);
    });
  },
);
