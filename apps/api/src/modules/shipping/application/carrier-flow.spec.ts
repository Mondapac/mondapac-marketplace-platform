import { createHmac } from 'node:crypto';
import { encodePayload, err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type {
  CallContext,
  Id,
  MarketContext,
  Money,
  PendingEvent,
  Result,
} from '@mondapac/shared-kernel';
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
  MemorySelection,
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
import { ConfigCarrierPolicy } from '../infrastructure/config-carrier-policy';
import { DriveWebhookSignature } from '../infrastructure/drive-webhook-signature';
import type {
  CarrierBookingAnswer,
  CarrierBookingRequest,
  CarrierFailure,
  CarrierGateway,
  CarrierQuote,
  CarrierQuoteRequest,
  CarrierStop,
} from './ports/carrier-gateway';
import type { ShippingDependencies } from './shipping-dependencies';
import { BookCarrierDelivery } from './use-cases/book-carrier-delivery.use-case';
import { CancelCarrierDelivery } from './use-cases/cancel-carrier-delivery.use-case';
import { CarrierTrackingLinks } from './use-cases/carrier-tracking-links.use-case';
import { CarrierShipmentQuery } from './use-cases/carrier-shipment.use-case';
import { ReceiveCarrierWebhook } from './use-cases/receive-carrier-webhook.use-case';
import { MAX_QUOTES_PER_CHECKOUT } from './shipping-fee-flow';
import { ShippingFees } from './use-cases/shipping-fees.use-case';
import { RecordingSecurityEvents } from '../../../../test/support/recording-security-events';

// The `real_time_delivery` flows in memory on both Market fixtures (AU: Mondapac Drive around
// greater-brisbane; ZZ: "Zed Courier" in zz-central only): the strategy, one booking per seller
// order, the carrier's signed webhooks taken once and forward only, and the cancellation.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const areas = loadServiceAreas(TEST_SERVICE_AREA_CONFIG_DIRS, TEST_MARKET_IDS);
const T0 = Temporal.Instant.from('2026-10-24T10:00:00Z');
const SECRET = 'drive-test-webhook-secret-0123456789abc';
const KEY = 'drive_test_key_0123456789abcdef';
const NO_KEYS = { isKnownPermissionKey: () => false };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ORDER = id<'Order'>(0x0a);
const SELLER_ORDER = id<'SellerOrder'>(0x5a);
const SELLER_ORDER_2 = id<'SellerOrder'>(0x5b);
const SELLER = id<'Seller'>(0x51);
const DELIVERY = '01990000-0000-7000-8000-0000000000d1';

/** Mondapac Drive's seat in the registry: scripted answers, capabilities from the Market config. */
class FakeCarrier implements CarrierGateway {
  readonly fleet = 'mondapac_drive' as const;
  readonly booked: CarrierBookingRequest[] = [];
  readonly cancelled: string[] = [];
  constructor(private readonly policy: () => ConfigCarrierPolicy) {}
  bookAnswer: Result<CarrierBookingAnswer, CarrierFailure> = ok({
    carrierReference: DELIVERY,
    carrierStatus: 'SCHEDULED',
    trackingUrl: null,
  });
  cancelAnswer: Result<{ readonly carrierStatus: string }, CarrierFailure> = ok({
    carrierStatus: 'CANCELLED',
  });
  capabilities(m: MarketContext) {
    return this.policy().driveCapabilities(m.marketId);
  }
  book(_m: MarketContext, request: CarrierBookingRequest) {
    this.booked.push(request);
    return Promise.resolve(this.bookAnswer);
  }
  cancel(_m: MarketContext, reference: string) {
    this.cancelled.push(reference);
    return Promise.resolve(this.cancelAnswer);
  }
  readonly quoted: CarrierQuoteRequest[] = [];
  quoteAnswer: Result<CarrierQuote, CarrierFailure> = err({ code: 'carrier.unavailable' });
  quote(_m: MarketContext, request: CarrierQuoteRequest) {
    this.quoted.push(request);
    return Promise.resolve(this.quoteAnswer);
  }
  status() {
    return Promise.resolve(err({ code: 'carrier.unavailable' } as const));
  }
}

const quoted = (amount: bigint, currency: string): Result<CarrierQuote, CarrierFailure> =>
  ok({ price: { amount, currency }, etaMinutes: null, expiresAt: null });

describe.each([
  ['AU', '4109', '4000', '2000'],
  ['ZZ', '1000001', '1000002', '2000500'],
] as const)('real-time carrier flows in market %s', (code, served, servedToo, unserved) => {
  const market = testMarketContext(code, 'default');
  const system = testCallContext(market, 'system', 'carrier-0001-abcd');
  const anonymous = testCallContext(market, 'anonymous', 'carrier-0002-abcd');
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const displayName = markets.get(market.marketId).shipping!.realTimeCarrier!.displayName;

  let clock: FixedClock;
  let bookings: MemoryBookings;
  let carrier: FakeCarrier;
  let registry: ListRegistry;
  let pickups: FakePickups;
  let written: PendingEvent[];
  let deps: ShippingDependencies;
  let securityEvents: RecordingSecurityEvents;

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
    notes: 'Leave at the door',
  });

  const withSecrets = (on: boolean) => {
    const secrets = on
      ? { apiKeys: { [code]: KEY }, webhookSecrets: { [code]: SECRET } }
      : { apiKeys: {}, webhookSecrets: {} };
    deps = {
      ...deps,
      carrierPolicy: new ConfigCarrierPolicy(markets, areas, secrets),
      webhookSignature: new DriveWebhookSignature(secrets.webhookSecrets, clock),
    };
  };

  beforeEach(() => {
    securityEvents = new RecordingSecurityEvents();
    clock = new FixedClock(T0);
    bookings = new MemoryBookings();
    carrier = new FakeCarrier(() => deps.carrierPolicy as ConfigCarrierPolicy);
    registry = new ListRegistry([carrier]);
    pickups = new FakePickups();
    pickups.answer = ok(pickup);
    written = [];
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      fees: undefined as never,
      policy: {
        currency: () => markets.get(market.marketId).defaultCurrency,
        timeZone: () => markets.get(market.marketId).timezone,
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
      fleets: registry,
      selection: new MemorySelection(),
      deliverySettings: undefined as never,
      carrierPolicy: undefined as never,
      pickups,
      webhookSignature: undefined as never,
      uberWebhookSignature: undefined as never,
      securityEvents,
    };
    withSecrets(true);
  });

  const book = (overrides: Record<string, unknown> = {}, context = system) =>
    new BookCarrierDelivery(gate, deps).execute(context, {
      orderId: ORDER,
      sellerOrderId: SELLER_ORDER,
      sellerId: SELLER,
      dropoff: dropoff(),
      service: { method: 'instant', window: null },
      ...overrides,
    });

  describe('book-carrier-delivery', () => {
    it('books a served seller order once, with an event of ids only', async () => {
      expect(await book()).toEqual(ok('booked'));
      expect(carrier.booked).toHaveLength(1);
      expect(carrier.booked[0]).toEqual({
        externalReference: SELLER_ORDER,
        pickup,
        dropoff: { ...dropoff(), locality: '', region: null, location: null },
        parcel: {
          ...markets.get(market.marketId).shipping!.realTimeCarrier!.parcel,
          itemCount: 1,
          declaredValue: { amount: 0n, currency: markets.get(market.marketId).defaultCurrency },
        },
        method: 'instant',
        mode: 'on_demand',
        window: null,
      });
      expect([...bookings.rows.values()]).toEqual([
        expect.objectContaining({
          sellerOrderId: SELLER_ORDER,
          carrierReference: DELIVERY,
          fleet: 'mondapac_drive',
          progress: 'booked',
          version: 1,
        }),
      ]);
      expect(written).toEqual([
        expect.objectContaining({
          type: 'shipping.carrier-delivery-progressed.v1',
          aggregateVersion: 1,
          payload: { orderId: ORDER, sellerOrderId: SELLER_ORDER, sellerId: SELLER },
        }),
      ]);

      expect(await book()).toEqual(ok('already-booked'));
      expect(carrier.booked).toHaveLength(1);
    });

    it('answers no-carrier outside the carrier areas or without the carrier (never a seller delivery)', async () => {
      expect(await book({ dropoff: dropoff(unserved) })).toEqual(ok('no-carrier'));
      pickups.answer = ok({ ...pickup, postcode: unserved });
      expect(await book()).toEqual(ok('no-carrier'));
      pickups.answer = err({ code: 'pickup.not-found' });
      expect(await book()).toEqual(ok('no-carrier'));
      pickups.answer = ok({ ...pickup, contactPhone: 'not a phone' });
      expect(await book()).toEqual(ok('no-carrier'));
      pickups.answer = ok(pickup);
      withSecrets(false);
      expect(await book()).toEqual(ok('no-carrier'));
      expect(carrier.booked).toEqual([]);
      expect(written).toEqual([]);
    });

    it('books a same-day order on demand and a scheduled one for the chosen window', async () => {
      expect(await book({ service: { method: 'same_day', window: null } })).toEqual(ok('booked'));
      expect(carrier.booked[0]).toMatchObject({
        method: 'same_day',
        mode: 'on_demand',
        window: null,
      });

      const start = '2026-10-26T01:00:00Z';
      const end = '2026-10-26T03:00:00Z';
      expect(
        await book({
          sellerOrderId: SELLER_ORDER_2,
          service: { method: 'scheduled', window: { start, end } },
        }),
      ).toEqual(ok('booked'));
      expect(carrier.booked[1]).toMatchObject({ method: 'scheduled', mode: 'scheduled' });
      expect(carrier.booked[1]!.window!.start.toString()).toBe('2026-10-26T01:00:00Z');
      expect(carrier.booked[1]!.window!.end.toString()).toBe('2026-10-26T03:00:00Z');
    });

    it('refuses a pickup, a scheduled order without a window and a window that ends first', async () => {
      const fields = async (service: unknown) => {
        const answer = await book({ service });
        return answer.ok ? 'ok' : (answer.error as { fields?: unknown }).fields;
      };
      expect(await fields({ method: 'pickup', window: null })).toEqual([
        { path: 'service.method', code: 'value' },
      ]);
      expect(await fields({ method: 'scheduled', window: null })).toEqual([
        { path: 'service.window.start', code: 'format' },
        { path: 'service.window.end', code: 'format' },
      ]);
      expect(
        await fields({
          method: 'scheduled',
          window: { start: '2026-10-26T03:00:00Z', end: '2026-10-26T01:00:00Z' },
        }),
      ).toEqual([{ path: 'service.window', code: 'range' }]);
      expect(await fields({ method: 'instant', window: { start: 'x', end: 'y' } })).toEqual([
        { path: 'service.window', code: 'not-allowed' },
      ]);
      expect(carrier.booked).toEqual([]);
    });

    it('answers refused on a carrier refusal and unavailable on a fault, storing nothing', async () => {
      carrier.bookAnswer = err({ code: 'carrier.refused' });
      expect(await book()).toEqual(ok('refused'));
      carrier.bookAnswer = err({ code: 'carrier.unavailable' });
      expect(await book()).toEqual(err({ code: 'shipping.carrier-unavailable' }));
      pickups.answer = err({ code: 'pickup.unavailable' });
      expect(await book()).toEqual(err({ code: 'shipping.carrier-unavailable' }));
      expect(bookings.rows.size).toBe(0);
      expect(written).toEqual([]);
    });

    it('validates the input by path and refuses any caller but the system', async () => {
      const bad = await book({ sellerOrderId: 'SO-1', dropoff: { ...dropoff(), postcode: '' } });
      expect(bad).toEqual(
        err({
          code: 'validation.failed',
          fields: [
            { path: 'sellerOrderId', code: 'format' },
            { path: 'dropoff.postcode', code: 'format' },
          ],
        }),
      );
      expect(await book({}, anonymous)).toMatchObject({
        ok: false,
        error: { code: 'access.denied' },
      });
    });
  });

  describe('receive-carrier-webhook', () => {
    let n = 0;
    const webhook = (
      status: string,
      overrides: { eventId?: string; marketId?: string; deliveryId?: string; type?: string } = {},
    ) => {
      n += 1;
      const payload = new TextEncoder().encode(
        JSON.stringify({
          id:
            overrides.eventId ??
            `01990000-0000-7000-8000-${(0xe000 + n).toString(16).padStart(12, '0')}`,
          type: overrides.type ?? 'delivery.status-changed',
          occurredAt: T0.toString(),
          marketId: overrides.marketId ?? code,
          data: {
            deliveryId: overrides.deliveryId ?? DELIVERY,
            externalReference: SELLER_ORDER,
            status,
          },
        }),
      );
      const timestamp = String(Math.floor(clock.now().epochMilliseconds / 1000));
      const signature = `v1=${createHmac('sha256', SECRET).update(`${timestamp}.`).update(payload).digest('hex')}`;
      return { payload, timestamp, signature };
    };
    const receive = (input: ReturnType<typeof webhook>) =>
      new ReceiveCarrierWebhook(gate, deps).execute(anonymous, input);
    const progress = () => [...bookings.rows.values()][0]?.progress;

    beforeEach(async () => {
      await book();
      written.length = 0;
    });

    it('moves the booking forward and announces each change of progress once', async () => {
      expect(await receive(webhook('ASSIGNED'))).toEqual(ok('applied'));
      expect(progress()).toBe('booked');
      expect(written).toEqual([]);

      const pickedUp = webhook('PICKED_UP');
      expect(await receive(pickedUp)).toEqual(ok('applied'));
      expect(progress()).toBe('picked-up');
      // The same event again (Drive delivers at least once).
      expect(await receive(pickedUp)).toEqual(ok('duplicate'));
      // An older status arriving late.
      expect(await receive(webhook('AT_PICKUP'))).toEqual(ok('unchanged'));
      expect(await receive(webhook('DELIVERED'))).toEqual(ok('applied'));
      expect(progress()).toBe('delivered');
      expect(await receive(webhook('DELIVERY_FAILED'))).toEqual(ok('unchanged'));
      expect(written.map((e) => e.aggregateVersion)).toEqual([3, 4]);

      clock.advance(Temporal.Duration.from({ seconds: 1 }));
      const shipment = await new CarrierShipmentQuery(gate, deps).execute(system, {
        sellerOrderId: SELLER_ORDER,
      });
      expect(shipment).toEqual(
        ok({
          sellerOrderId: SELLER_ORDER,
          carrierName: displayName,
          trackingRef: DELIVERY,
          trackingUrl: null,
          progress: 'delivered',
        }),
      );
    });

    it('maps a failed or returned delivery to an exception', async () => {
      expect(await receive(webhook('RETURNED'))).toEqual(ok('applied'));
      expect(progress()).toBe('exception');
    });

    it('takes an unknown status or event type without acting on it', async () => {
      expect(await receive(webhook('TELEPORTED'))).toEqual(ok('ignored'));
      expect(await receive(webhook('PICKED_UP', { type: 'courier.location-updated' }))).toEqual(
        ok('ignored'),
      );
      expect(progress()).toBe('booked');
    });

    it('refuses a bad signature, another Market, another delivery or no booking', async () => {
      const signed = webhook('PICKED_UP');
      expect(await receive({ ...signed, signature: signed.signature.replace(/.$/, '0') })).toEqual(
        err({ code: 'shipping.signature-invalid' }),
      );
      const old = webhook('PICKED_UP');
      clock.advance(Temporal.Duration.from({ minutes: 6 }));
      expect(await receive(old)).toEqual(err({ code: 'shipping.signature-invalid' }));
      // Both failures are security events (SOC package 1).
      expect(securityEvents.events.map((event) => [event.type, event.payload])).toEqual([
        ['shipping.webhook-signature.failed', { carrier: 'mondapac-drive' }],
        ['shipping.webhook-signature.failed', { carrier: 'mondapac-drive' }],
      ]);
      expect(
        await receive(webhook('PICKED_UP', { marketId: code === 'AU' ? 'ZZ' : 'AU' })),
      ).toEqual(err({ code: 'shipping.event-refused' }));
      expect(
        await receive(webhook('PICKED_UP', { deliveryId: '01990000-0000-7000-8000-0000000000d9' })),
      ).toEqual(err({ code: 'shipping.event-refused' }));
      bookings.rows.clear();
      expect(await receive(webhook('PICKED_UP'))).toEqual(
        err({ code: 'shipping.carrier-delivery-not-found' }),
      );
      expect(written).toEqual([]);
    });

    it('answers unavailable while the Market has no webhook secret', async () => {
      withSecrets(false);
      expect(await receive(webhook('PICKED_UP'))).toEqual(
        err({ code: 'shipping.webhook-unavailable' }),
      );
    });
  });

  describe('cancel-carrier-delivery', () => {
    const cancel = () =>
      new CancelCarrierDelivery(gate, deps).execute(system, { sellerOrderId: SELLER_ORDER });

    it('cancels a booking not yet picked up, once', async () => {
      expect(await cancel()).toEqual(ok('none'));
      await book();
      written.length = 0;
      expect(await cancel()).toEqual(ok('cancelled'));
      expect(carrier.cancelled).toEqual([DELIVERY]);
      expect([...bookings.rows.values()][0]?.progress).toBe('cancelled');
      expect(written).toHaveLength(1);
      expect(await cancel()).toEqual(ok('cancelled'));
      expect(carrier.cancelled).toHaveLength(1);
    });

    it('does not cancel once the carrier refuses or has picked it up', async () => {
      await book();
      carrier.cancelAnswer = err({ code: 'carrier.refused' });
      expect(await cancel()).toEqual(ok('not-cancellable'));
      carrier.cancelAnswer = err({ code: 'carrier.unavailable' });
      expect(await cancel()).toEqual(err({ code: 'shipping.carrier-unavailable' }));
      const [key, row] = [...bookings.rows.entries()][0]!;
      bookings.rows.set(key, { ...row, progress: 'picked-up' });
      expect(await cancel()).toEqual(ok('not-cancellable'));
    });
  });
  describe('shipping-fees (the live quote at checkout)', () => {
    const currency = markets.get(market.marketId).defaultCurrency;
    const customer = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'customer',
        accountId: id<'Account'>(0x61),
        sessionId: id<'Session'>(0x62),
        sellerId: null,
      }),
      'carrier-0003-abcd',
    );
    const OTHER = id<'Seller'>(0x52);
    const flat = (amount: bigint): Money => ({ amount, currency });
    let flatFees: Map<string, Money>;

    beforeEach(() => {
      withSecrets(true);
      flatFees = new Map([
        [SELLER, flat(1000n)],
        [OTHER, flat(900n)],
      ]);
      deps = {
        ...deps,
        policy: {
          currency: () => currency,
          timeZone: () => 'Australia/Brisbane',
          deliversTo: () => true,
        },
        fees: {
          findMany: (_m: MarketContext, ids: readonly Id<'Seller'>[]) =>
            Promise.resolve(
              ids.flatMap((sellerId) => {
                const fee = flatFees.get(sellerId);
                return fee === undefined ? [] : [{ sellerId, fee, updatedAt: T0 }];
              }),
            ),
        } as never,
      };
      pickups.postcodes = ok(new Map([[SELLER, servedToo]]));
      carrier.quoteAnswer = quoted(1250n, currency);
    });

    const fees = (
      sellerIds: readonly string[] = [SELLER, OTHER],
      dropoffPostcode: string = served,
      context: CallContext = customer,
    ) =>
      new ShippingFees(gate, deps).execute(context, {
        sellerIds,
        dropoff: { postcode: dropoffPostcode },
      });

    it('charges the quote where the carrier carries it, the flat fee elsewhere', async () => {
      expect(await fees()).toEqual(
        ok({
          fees: new Map([
            [SELLER, { amount: 1250n, currency }],
            [OTHER, flat(900n)],
          ]),
          quoted: new Set([SELLER]),
        }),
      );
      // Postcodes only: never a street, a suburb the customer typed, a name or a phone.
      expect(carrier.quoted).toEqual([
        {
          pickup: { postcode: servedToo, locality: null, region: null },
          dropoff: { postcode: served, locality: null, region: null },
          parcel: {
            ...markets.get(market.marketId).shipping!.realTimeCarrier!.parcel,
            itemCount: 1,
            declaredValue: { amount: 0n, currency },
          },
          method:
            markets.get(market.marketId).shipping!.realTimeCarrier!.mode === 'scheduled'
              ? 'scheduled'
              : 'instant',
          mode: markets.get(market.marketId).shipping!.realTimeCarrier!.mode,
        },
      ]);
    });

    it('quotes a seller without a flat fee, and keeps the flat fee when a quote fails', async () => {
      flatFees.delete(SELLER);
      expect(await fees()).toEqual(
        ok({
          fees: new Map([
            [OTHER, flat(900n)],
            [SELLER, { amount: 1250n, currency }],
          ]),
          quoted: new Set([SELLER]),
        }),
      );
      flatFees.set(SELLER, flat(1000n));
      const { minMinor, maxMinor } = markets.get(market.marketId).shipping!.realTimeCarrier!
        .quoteBounds;
      for (const answer of [
        err({ code: 'carrier.unavailable' } as const),
        err({ code: 'carrier.refused' } as const),
        quoted(1250n, currency === 'AUD' ? 'JPY' : 'AUD'),
        // A quote outside the Market's bounds is never charged: free, or absurdly high.
        quoted(BigInt(minMinor) - 1n, currency),
        quoted(BigInt(maxMinor) + 1n, currency),
      ]) {
        carrier.quoteAnswer = answer;
        const result = await fees();
        expect(result.ok && result.value.fees.get(SELLER)).toEqual(flat(1000n));
        expect(result.ok && result.value.quoted.size).toBe(0);
      }
    });

    it('asks no quote when the carrier is off, the drop-off or the pickup is not served, or the pickup is unknown', async () => {
      const flatOnly = ok({
        fees: new Map([
          [SELLER, flat(1000n)],
          [OTHER, flat(900n)],
        ]),
        quoted: new Set(),
      });
      expect(await fees([SELLER, OTHER], unserved)).toEqual(flatOnly);
      pickups.postcodes = ok(new Map([[SELLER, unserved]]));
      expect(await fees()).toEqual(flatOnly);
      pickups.postcodes = err({ code: 'pickup.unavailable' });
      expect(await fees()).toEqual(flatOnly);
      pickups.postcodes = ok(new Map([[SELLER, servedToo]]));
      withSecrets(false);
      expect(await fees()).toEqual(flatOnly);
      expect(carrier.quoted).toEqual([]);
    });

    it('quotes at most the per-checkout cap, and refuses a malformed request or another actor', async () => {
      const many = Array.from({ length: MAX_QUOTES_PER_CHECKOUT + 2 }, (_, n) =>
        id<'Seller'>(0x700 + n),
      );
      pickups.postcodes = ok(new Map(many.map((sellerId) => [sellerId, servedToo])));
      const result = await fees(many);
      expect(carrier.quoted).toHaveLength(MAX_QUOTES_PER_CHECKOUT);
      expect(result.ok && result.value.fees.size).toBe(MAX_QUOTES_PER_CHECKOUT);

      expect(await fees([SELLER], '')).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
      expect(await fees(['nope'])).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
      expect(await fees([SELLER], served, anonymous)).toMatchObject({
        ok: false,
        error: { code: 'access.unauthenticated' },
      });
    });
  });
  describe('tracking link', () => {
    const customer = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'customer',
        accountId: id<'Account'>(0x61),
        sessionId: id<'Session'>(0x62),
        sellerId: null,
      }),
      'carrier-0004-abcd',
    );
    const links = (ids: unknown[], context = customer, orderId: unknown = ORDER) =>
      new CarrierTrackingLinks(gate, deps).execute(context, { orderId, sellerOrderIds: ids });

    it('stores the https link the fleet gave and reads it back for ordering and the buyer', async () => {
      carrier.bookAnswer = ok({
        carrierReference: DELIVERY,
        carrierStatus: 'SCHEDULED',
        trackingUrl: 'https://track.example.com/d/abc',
      });
      expect(await book()).toEqual(ok('booked'));

      expect([...bookings.rows.values()][0]!.trackingUrl).toBe('https://track.example.com/d/abc');
      const shipment = await new CarrierShipmentQuery(gate, deps).execute(system, {
        sellerOrderId: SELLER_ORDER,
      });
      expect(shipment.ok && shipment.value.trackingUrl).toBe('https://track.example.com/d/abc');
      expect(await links([SELLER_ORDER, SELLER_ORDER_2])).toEqual(
        ok(new Map([[SELLER_ORDER, 'https://track.example.com/d/abc']])),
      );
    });

    it.each([
      'http://track.example.com/d/abc',
      'javascript:alert(1)',
      'https://u:p@x.example/a',
      '/relative',
    ])('stores no link for %s', async (url) => {
      carrier.bookAnswer = ok({
        carrierReference: DELIVERY,
        carrierStatus: 'SCHEDULED',
        trackingUrl: url,
      });
      expect(await book()).toEqual(ok('booked'));
      expect([...bookings.rows.values()][0]!.trackingUrl).toBeNull();
      expect(await links([SELLER_ORDER])).toEqual(ok(new Map()));
    });

    it('re-checks a stored link on the way out', async () => {
      expect(await book()).toEqual(ok('booked'));
      const [row] = [...bookings.rows.entries()];
      bookings.rows.set(row![0], { ...row![1], trackingUrl: 'http://old.example.com/x' });
      const shipment = await new CarrierShipmentQuery(gate, deps).execute(system, {
        sellerOrderId: SELLER_ORDER,
      });
      expect(shipment.ok && shipment.value.trackingUrl).toBeNull();
      expect(await links([SELLER_ORDER])).toEqual(ok(new Map()));
    });

    it("answers no link for another order's id and refuses an actor that is not a customer", async () => {
      carrier.bookAnswer = ok({
        carrierReference: DELIVERY,
        carrierStatus: 'SCHEDULED',
        trackingUrl: 'https://track.example.com/d/abc',
      });
      expect(await book()).toEqual(ok('booked'));

      // The booking belongs to ORDER: asked under any other order id, nothing leaves.
      expect(await links([SELLER_ORDER], customer, id<'Order'>(0x0b))).toEqual(ok(new Map()));
      expect(await links([SELLER_ORDER], customer, 'nope')).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
      // A seller, an admin and the system are not the buyer of an order.
      for (const population of ['seller', 'admin'] as const) {
        const other = testCallContext(
          market,
          testAuthenticatedActor(market, {
            population,
            accountId: id<'Account'>(0x63),
            sessionId: id<'Session'>(0x64),
            sellerId: population === 'seller' ? SELLER : null,
          }),
          'carrier-0005-abcd',
        );
        expect(await links([SELLER_ORDER], other)).toMatchObject({
          ok: false,
          error: { code: 'access.denied' },
        });
      }
      expect(await links([SELLER_ORDER], system)).toMatchObject({
        ok: false,
        error: { code: 'access.denied' },
      });
    });

    it('refuses malformed ids, too many ids and a caller with no session, and reads one Market only', async () => {
      expect(await links(['nope'])).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
      expect(await links(Array.from({ length: 51 }, () => SELLER_ORDER))).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
      expect(await links([SELLER_ORDER], anonymous)).toMatchObject({
        ok: false,
        error: { code: 'access.unauthenticated' },
      });
    });
  });
});
