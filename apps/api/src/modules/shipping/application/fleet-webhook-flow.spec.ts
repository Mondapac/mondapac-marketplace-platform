import { createHmac } from 'node:crypto';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, PendingEvent, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { ListRegistry, MemoryBookings } from '../../../../test/support/shipping-fakes';
import { TEST_MARKETS } from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { newBooking, type CarrierBooking } from '../domain/carrier-booking';
import type { FleetCapabilities, FleetCode, FleetDeliveryStatus } from '../domain/fleet';
import { UberWebhookSignature } from '../infrastructure/uber-webhook-signature';
import type { CarrierFailure, CarrierGateway } from './ports/carrier-gateway';
import { POLL_BATCH, uberEventKey } from './fleet-webhook-flow';
import type { ShippingDependencies } from './shipping-dependencies';
import { PollFleetStatus } from './use-cases/poll-fleet-status.use-case';
import { ReceiveUberWebhook } from './use-cases/receive-uber-webhook.use-case';

// Uber Direct's signed status webhook and the status poll of Zoom2u and Australia Post, in memory
// on both Market fixtures. The fleets are scripted; the signature is the real HMAC check.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-25T10:00:00Z');
const SECRET = 'uber-test-webhook-secret-0123456789abc';
const NO_KEYS = { isKnownPermissionKey: () => false };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const UBER_ID = 'del_abcdefgh1234';

class ScriptedFleet implements CarrierGateway {
  on = true;
  readonly asked: string[] = [];
  answers = new Map<
    string,
    Result<{ status: FleetDeliveryStatus; carrierStatus: string }, CarrierFailure>
  >();
  constructor(readonly fleet: FleetCode) {}
  capabilities(): FleetCapabilities | null {
    return this.on ? ({ fleet: this.fleet } as FleetCapabilities) : null;
  }
  book(): never {
    throw new Error('not used');
  }
  quote(): never {
    throw new Error('not used');
  }
  cancel(): never {
    throw new Error('not used');
  }
  status(_m: MarketContext, reference: string) {
    this.asked.push(reference);
    return Promise.resolve(
      this.answers.get(reference) ?? err({ code: 'carrier.unavailable' } as const),
    );
  }
}

describe('uberEventKey', () => {
  it('is a stable UUID-shaped key per event id, whatever Uber ids look like', () => {
    const key = uberEventKey('evt_1');
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(uberEventKey('evt_1')).toBe(key);
    expect(uberEventKey('evt_2')).not.toBe(key);
  });
});

describe.each(TEST_MARKETS)('fleet status flows in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const system = testCallContext(market, 'system', 'fleet-status-0001');
  const anonymous = testCallContext(market, 'anonymous', 'fleet-status-0002');
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });

  let clock: FixedClock;
  let bookings: MemoryBookings;
  let uber: ScriptedFleet;
  let zoom: ScriptedFleet;
  let auspost: ScriptedFleet;
  let written: PendingEvent[];
  let deps: ShippingDependencies;
  let n: number;

  const seed = (fleet: FleetCode, reference: string, extra: Partial<CarrierBooking> = {}) => {
    n += 1;
    const booking = {
      ...newBooking({
        id: id<'CarrierBooking'>(0xb00 + n),
        sellerOrderId: id<'SellerOrder'>(0x500 + n),
        orderId: id<'Order'>(0xa00 + n),
        sellerId: id<'Seller'>(0x51),
        fleet,
        carrierReference: reference,
        carrierStatus: 'PENDING',
        now: T0,
      }),
      ...extra,
    };
    void bookings.insert(market, booking);
    return booking;
  };
  const stored = (booking: CarrierBooking) =>
    bookings.rows.get(`${code}|${booking.sellerOrderId}`)!;

  const bodyOf = (
    status: string,
    eventId = 'evt_0001',
    extra: Record<string, unknown> = {},
    deliveryId = UBER_ID,
  ) =>
    JSON.stringify({
      kind: 'event.delivery_status',
      id: eventId,
      delivery_id: deliveryId,
      status,
      data: { id: deliveryId, status, external_id: 'ignored', ...extra },
    });
  const sign = (body: string, secret = SECRET) =>
    createHmac('sha256', secret).update(body).digest('hex');
  const receive = (body: string, signature: unknown = sign(body), context = anonymous) =>
    new ReceiveUberWebhook(gate, deps).execute(context, {
      payload: new TextEncoder().encode(body),
      signature,
    });
  const poll = () => new PollFleetStatus(gate, deps).execute(system, {});

  beforeEach(() => {
    n = 0;
    clock = new FixedClock(T0);
    bookings = new MemoryBookings();
    uber = new ScriptedFleet('uber_direct');
    zoom = new ScriptedFleet('zoom2u');
    auspost = new ScriptedFleet('auspost');
    written = [];
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      clock,
      ids: new SequenceIdGenerator(clock),
      outbox: {
        append: (_c: unknown, events: readonly PendingEvent[]) => {
          void NO_KEYS;
          written.push(...events);
          return Promise.resolve();
        },
      },
      bookings,
      fleets: new ListRegistry([uber, zoom, auspost]),
      uberWebhookSignature: new UberWebhookSignature({ [code]: SECRET }),
    } as unknown as ShippingDependencies;
  });

  describe('receive-uber-webhook', () => {
    it('applies a signed pickup then delivery once each, with a proof-of-delivery instant only', async () => {
      const booking = seed('uber_direct', UBER_ID);

      expect(await receive(bodyOf('pickup_complete', 'evt_1'))).toEqual(ok('applied'));
      expect(stored(booking).progress).toBe('picked-up');
      clock.advance(Temporal.Duration.from({ seconds: 30 }));
      const delivered = bodyOf('delivered', 'evt_2', {
        verification: { picture: { image_url: 'https://pod.example/photo.jpg' } },
        dropoff: { name: 'Aisha Rahman' },
      });
      expect(await receive(delivered)).toEqual(ok('applied'));

      const row = stored(booking);
      expect(row.progress).toBe('delivered');
      expect(row.carrierStatus).toBe('DELIVERED');
      expect(row.podRecordedAt?.toString()).toBe(clock.now().toString());
      // Nothing of the proof or the recipient is kept anywhere on the booking.
      expect(JSON.stringify(row)).not.toMatch(/photo|Aisha|verification/);
      expect(written.map((e) => e.type)).toEqual([
        'shipping.carrier-delivery-progressed.v1',
        'shipping.carrier-delivery-progressed.v1',
      ]);
    });

    it('takes a repeated event once and changes nothing the second time', async () => {
      seed('uber_direct', UBER_ID);
      const body = bodyOf('pickup_complete', 'evt_1');

      expect(await receive(body)).toEqual(ok('applied'));
      expect(await receive(body)).toEqual(ok('duplicate'));
      expect(written).toHaveLength(1);
      expect([...bookings.events]).toEqual([`${code}|uber_direct|${uberEventKey('evt_1')}`]);
    });

    it('does not record that a proof exists when the fleet sent none, nor on a non-final status', async () => {
      const booking = seed('uber_direct', UBER_ID);
      await receive(bodyOf('pickup_complete', 'evt_1', { verification: { signature: {} } }));
      expect(stored(booking).podRecordedAt).toBeNull();
      await receive(bodyOf('delivered', 'evt_2'));
      expect(stored(booking).podRecordedAt).toBeNull();
    });

    it('refuses a bad, missing or other-secret signature and a changed body, applying nothing', async () => {
      const booking = seed('uber_direct', UBER_ID);
      const body = bodyOf('delivered');
      const failures = [
        await receive(body, sign(body, 'another-secret-0123456789abcdefgh')),
        await receive(body, null),
        await receive(body, ''),
        await receive(body, 'not-hex'),
        await receive(body, sign(body).toUpperCase().slice(0, 60)),
        await receive(body.replace('delivered', 'canceled'), sign(body)),
      ];
      for (const result of failures) {
        expect(result).toEqual(err({ code: 'shipping.signature-invalid' }));
      }
      expect(stored(booking).progress).toBe('booked');
      expect(bookings.events.size).toBe(0);
    });

    it('accepts an upper-case hex signature', async () => {
      seed('uber_direct', UBER_ID);
      const body = bodyOf('pickup');
      expect(await receive(body, sign(body).toUpperCase())).toEqual(ok('applied'));
    });

    it('is not found while the fleet is off for the Market, before the signature is looked at', async () => {
      seed('uber_direct', UBER_ID);
      uber.on = false;
      const body = bodyOf('delivered');
      expect(await receive(body)).toEqual(err({ code: 'shipping.fleet-off' }));
      expect(await receive(body, 'garbage')).toEqual(err({ code: 'shipping.fleet-off' }));
    });

    it('is unavailable without a signing secret for the Market', async () => {
      deps = { ...deps, uberWebhookSignature: new UberWebhookSignature({}) };
      expect(await receive(bodyOf('delivered'))).toEqual(
        err({ code: 'shipping.webhook-unavailable' }),
      );
    });

    it('does not trust the body for the Market or the fleet: an unknown delivery is not found', async () => {
      const own = seed('mondapac_drive', 'drive-reference-1');
      expect(await receive(bodyOf('delivered', 'evt_1', {}, 'del_unknown_9999'))).toEqual(
        err({ code: 'shipping.carrier-delivery-not-found' }),
      );
      // A delivery id that belongs to another fleet's booking is not Uber's to move.
      expect(await receive(bodyOf('delivered', 'evt_2', {}, 'drive-reference-1'))).toEqual(
        err({ code: 'shipping.carrier-delivery-not-found' }),
      );
      expect(stored(own).progress).toBe('booked');
    });

    it('answers validation for a body that is not an event, and acknowledges other kinds', async () => {
      seed('uber_direct', UBER_ID);
      for (const body of ['[]', 'null', '{', JSON.stringify({ kind: 'event.delivery_status' })]) {
        expect(await receive(body)).toEqual(err({ code: 'validation.failed' }));
      }
      const other = JSON.stringify({ kind: 'event.courier_update', id: 'evt_9' });
      expect(await receive(other)).toEqual(ok('ignored'));
    });

    it('takes an unknown status word and ignores it', async () => {
      const booking = seed('uber_direct', UBER_ID);
      expect(await receive(bodyOf('some_new_status', 'evt_1'))).toEqual(ok('ignored'));
      expect(stored(booking).progress).toBe('booked');
      expect(await receive(bodyOf('some_new_status', 'evt_1'))).toEqual(ok('duplicate'));
    });

    it('never moves a booking backwards and keeps a final state', async () => {
      const booking = seed('uber_direct', UBER_ID);
      await receive(bodyOf('delivered', 'evt_1'));
      expect(await receive(bodyOf('pickup', 'evt_2'))).toEqual(ok('unchanged'));
      expect(await receive(bodyOf('canceled', 'evt_3'))).toEqual(ok('unchanged'));
      expect(stored(booking).progress).toBe('delivered');
    });

    it('rolls back (throws) when a concurrent change wins, so Uber sends the event again', async () => {
      seed('uber_direct', UBER_ID);
      const original = bookings.save.bind(bookings);
      bookings.save = () => Promise.resolve('conflict' as const);
      await expect(receive(bodyOf('delivered'))).rejects.toThrow('changed meanwhile');
      bookings.save = original;
    });
  });

  describe('poll-fleet-status', () => {
    it('asks Zoom2u and Australia Post about their open bookings and applies the answers', async () => {
      const z = seed('zoom2u', 'zoom-ref-0001');
      const a = seed('auspost', 'ap-ref-0001');
      const u = seed('uber_direct', UBER_ID);
      zoom.answers.set('zoom-ref-0001', ok({ status: 'picked_up', carrierStatus: 'PICKED_UP' }));
      auspost.answers.set('ap-ref-0001', ok({ status: 'delivered', carrierStatus: 'DELIVERED' }));

      expect(await poll()).toEqual(ok({ fleets: 2, asked: 2, changed: 2, failed: 0 }));

      expect(stored(z).progress).toBe('picked-up');
      expect(stored(a).progress).toBe('delivered');
      // Uber pushes a webhook and is never polled.
      expect(uber.asked).toEqual([]);
      expect(stored(u).progress).toBe('booked');
      expect(written).toHaveLength(2);
      expect(stored(z).polledAt?.toString()).toBe(T0.toString());
    });

    it('leaves a fleet that is off for the Market alone, and asks nothing', async () => {
      seed('zoom2u', 'zoom-ref-0001');
      zoom.on = false;
      auspost.on = false;
      expect(await poll()).toEqual(ok({ fleets: 0, asked: 0, changed: 0, failed: 0 }));
      expect(zoom.asked).toEqual([]);
    });

    it('skips bookings that are final, and polls an unchanged one without an event', async () => {
      auspost.on = false;
      seed('zoom2u', 'zoom-final', { progress: 'delivered' });
      const open = seed('zoom2u', 'zoom-open');
      zoom.answers.set('zoom-open', ok({ status: 'pending', carrierStatus: 'PENDING' }));
      expect(await poll()).toEqual(ok({ fleets: 1, asked: 1, changed: 0, failed: 0 }));
      expect(zoom.asked).toEqual(['zoom-open']);
      expect(stored(open).version).toBe(1);
      expect(written).toEqual([]);
    });

    it('counts a failed answer, marks it asked and carries on with the next booking', async () => {
      auspost.on = false;
      const bad = seed('zoom2u', 'zoom-bad');
      seed('zoom2u', 'zoom-good');
      zoom.answers.set('zoom-good', ok({ status: 'delivered', carrierStatus: 'DELIVERED' }));
      expect(await poll()).toEqual(ok({ fleets: 1, asked: 2, changed: 1, failed: 1 }));
      expect(stored(bad).polledAt).not.toBeNull();
      expect(stored(bad).progress).toBe('booked');
    });

    it('stops asking a fleet whose credentials are refused for the rest of the run', async () => {
      zoom.on = false;
      seed('auspost', 'ap-1');
      seed('auspost', 'ap-2');
      auspost.answers.set('ap-1', err({ code: 'carrier.unauthorized' }));
      expect(await poll()).toEqual(ok({ fleets: 1, asked: 1, changed: 0, failed: 1 }));
      expect(auspost.asked).toEqual(['ap-1']);
    });

    it('asks at most one batch per fleet, least recently asked first', async () => {
      for (let k = 0; k < POLL_BATCH + 5; k += 1) {
        seed('zoom2u', `zoom-${String(k).padStart(3, '0')}`);
      }
      await poll();
      expect(zoom.asked).toHaveLength(POLL_BATCH);
      const first = [...zoom.asked];
      zoom.asked.length = 0;
      clock.advance(Temporal.Duration.from({ minutes: 5 }));
      await poll();
      // The five never asked go before any asked a second time.
      expect(zoom.asked.slice(0, 5).every((ref) => !first.includes(ref))).toBe(true);
    });

    it('does not move a booking of the other Market', async () => {
      const otherMarket = TEST_MARKETS.find((m) => m !== code)!;
      const other = testMarketContext(otherMarket, 'default');
      await bookings.insert(
        other,
        newBooking({
          id: id<'CarrierBooking'>(0xfff),
          sellerOrderId: id<'SellerOrder'>(0xfff),
          orderId: id<'Order'>(0xfff),
          sellerId: id<'Seller'>(0x51),
          fleet: 'zoom2u',
          carrierReference: 'zoom-other-market',
          carrierStatus: 'PENDING',
          now: T0,
        }),
      );
      await poll();
      expect(zoom.asked).toEqual([]);
    });
  });
});
