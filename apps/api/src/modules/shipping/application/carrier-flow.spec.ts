import { createHmac } from 'node:crypto';
import { encodePayload, err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, PendingEvent, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_SERVICE_AREA_CONFIG_DIRS,
} from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { loadServiceAreas } from '../../../platform/market-config/service-area-config';
import type { CarrierBooking } from '../domain/carrier-booking';
import { SHIPPING_EVENTS } from '../domain/events';
import { ConfigCarrierPolicy } from '../infrastructure/config-carrier-policy';
import { DriveWebhookSignature } from '../infrastructure/drive-webhook-signature';
import type { CarrierBookingRepository } from './ports/carrier-booking.repository';
import type {
  CarrierBookingAnswer,
  CarrierBookingRequest,
  CarrierFailure,
  CarrierGateway,
  CarrierStop,
} from './ports/carrier-gateway';
import type { PickupDirectory } from './ports/pickup-directory';
import type { ShippingDependencies } from './shipping-dependencies';
import { BookCarrierDelivery } from './use-cases/book-carrier-delivery.use-case';
import { CancelCarrierDelivery } from './use-cases/cancel-carrier-delivery.use-case';
import { CarrierShipmentQuery } from './use-cases/carrier-shipment.use-case';
import { ReceiveCarrierWebhook } from './use-cases/receive-carrier-webhook.use-case';

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
const SELLER = id<'Seller'>(0x51);
const DELIVERY = '01990000-0000-7000-8000-0000000000d1';

class MemoryBookings implements CarrierBookingRepository {
  readonly rows = new Map<string, CarrierBooking>();
  readonly events = new Set<string>();
  findBySellerOrder(m: MarketContext, sellerOrderId: Id<'SellerOrder'>) {
    return Promise.resolve(this.rows.get(`${m.marketId}|${sellerOrderId}`) ?? null);
  }
  insert(m: MarketContext, booking: CarrierBooking) {
    const key = `${m.marketId}|${booking.sellerOrderId}`;
    if (this.rows.has(key)) return Promise.resolve('exists' as const);
    this.rows.set(key, booking);
    return Promise.resolve('inserted' as const);
  }
  save(m: MarketContext, booking: CarrierBooking, expectedVersion: number) {
    const key = `${m.marketId}|${booking.sellerOrderId}`;
    if (this.rows.get(key)?.version !== expectedVersion)
      return Promise.resolve('conflict' as const);
    this.rows.set(key, booking);
    return Promise.resolve('saved' as const);
  }
  recordEvent(m: MarketContext, event: { readonly eventId: string; readonly carrier: string }) {
    const key = `${m.marketId}|${event.carrier}|${event.eventId}`;
    if (this.events.has(key)) return Promise.resolve('duplicate' as const);
    this.events.add(key);
    return Promise.resolve('recorded' as const);
  }
}

class FakeCarrier implements CarrierGateway {
  readonly booked: CarrierBookingRequest[] = [];
  readonly cancelled: string[] = [];
  bookAnswer: Result<CarrierBookingAnswer, CarrierFailure> = ok({
    carrierReference: DELIVERY,
    carrierStatus: 'SCHEDULED',
  });
  cancelAnswer: Result<{ readonly carrierStatus: string }, CarrierFailure> = ok({
    carrierStatus: 'CANCELLED',
  });
  book(_m: MarketContext, request: CarrierBookingRequest) {
    this.booked.push(request);
    return Promise.resolve(this.bookAnswer);
  }
  cancel(_m: MarketContext, reference: string) {
    this.cancelled.push(reference);
    return Promise.resolve(this.cancelAnswer);
  }
}

class FakePickups implements PickupDirectory {
  answer: Result<CarrierStop, { readonly code: 'pickup.not-found' | 'pickup.unavailable' }> = err({
    code: 'pickup.not-found',
  });
  pickupOf() {
    return Promise.resolve(this.answer);
  }
}

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
  let pickups: FakePickups;
  let written: PendingEvent[];
  let deps: ShippingDependencies;

  const pickup: CarrierStop = {
    contactName: 'Test Halal Butcher',
    contactPhone: '+61 7 3000 0000',
    addressLines: ['1 Shop Street'],
    postcode: servedToo,
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
    clock = new FixedClock(T0);
    bookings = new MemoryBookings();
    carrier = new FakeCarrier();
    pickups = new FakePickups();
    pickups.answer = ok(pickup);
    written = [];
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      fees: undefined as never,
      policy: undefined as never,
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
      carrier,
      carrierPolicy: undefined as never,
      pickups,
      webhookSignature: undefined as never,
    };
    withSecrets(true);
  });

  const book = (overrides: Record<string, unknown> = {}, context = system) =>
    new BookCarrierDelivery(gate, deps).execute(context, {
      orderId: ORDER,
      sellerOrderId: SELLER_ORDER,
      sellerId: SELLER,
      dropoff: dropoff(),
      ...overrides,
    });

  describe('book-carrier-delivery', () => {
    it('books a served seller order once, with an event of ids only', async () => {
      expect(await book()).toEqual(ok('booked'));
      expect(carrier.booked).toHaveLength(1);
      expect(carrier.booked[0]).toEqual({
        externalReference: SELLER_ORDER,
        pickup,
        dropoff: dropoff(),
        parcel: markets.get(market.marketId).shipping!.realTimeCarrier!.parcel,
        mode: markets.get(market.marketId).shipping!.realTimeCarrier!.mode,
      });
      expect([...bookings.rows.values()]).toEqual([
        expect.objectContaining({
          sellerOrderId: SELLER_ORDER,
          carrierReference: DELIVERY,
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

    it('leaves it to the seller outside the carrier areas or without the carrier', async () => {
      expect(await book({ dropoff: dropoff(unserved) })).toEqual(ok('seller-managed'));
      pickups.answer = ok({ ...pickup, postcode: unserved });
      expect(await book()).toEqual(ok('seller-managed'));
      pickups.answer = err({ code: 'pickup.not-found' });
      expect(await book()).toEqual(ok('seller-managed'));
      pickups.answer = ok({ ...pickup, contactPhone: 'not a phone' });
      expect(await book()).toEqual(ok('seller-managed'));
      pickups.answer = ok(pickup);
      withSecrets(false);
      expect(await book()).toEqual(ok('seller-managed'));
      expect(carrier.booked).toEqual([]);
      expect(written).toEqual([]);
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
});
