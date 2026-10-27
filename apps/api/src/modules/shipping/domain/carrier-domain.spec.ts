import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  advanceBooking,
  isFinalProgress,
  newBooking,
  progressOfFleetStatus,
  type CarrierBooking,
} from './carrier-booking';
import { addressLineOf, parseCarrierStop } from './carrier-stop';
import { parseDriveWebhook, toFleetStatus } from './drive-webhook-event';
import { fulfilmentStrategyFor, REAL_TIME_DELIVERY, NO_CARRIER } from './real-time-delivery';

// The pure rules of the real-time carrier (SHP-02/03): Drive status to progress, forward-only
// progress, the strategy, the checks on a stop and on a webhook body. Market-free; the flows
// that use them run on AU and ZZ in carrier-flow.spec.ts.

const T0 = Temporal.Instant.from('2026-10-24T10:00:00Z');
const T1 = T0.add({ minutes: 5 });
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};

const booking = (overrides: Partial<CarrierBooking> = {}): CarrierBooking => ({
  ...newBooking({
    id: id<'CarrierBooking'>(1),
    sellerOrderId: id<'SellerOrder'>(2),
    orderId: id<'Order'>(3),
    sellerId: id<'Seller'>(4),
    fleet: 'mondapac_drive',
    carrierReference: id(5),
    carrierStatus: 'SCHEDULED',
    now: T0,
  }),
  ...overrides,
});

describe("Drive's status words through the common fleet status", () => {
  it.each([
    ['SCHEDULED', 'pending', 'booked'],
    ['DISPATCHING', 'pending', 'booked'],
    ['ASSIGNED', 'assigned', 'booked'],
    ['AT_PICKUP', 'assigned', 'booked'],
    ['PICKED_UP', 'picked_up', 'picked-up'],
    ['AT_DROPOFF', 'picked_up', 'picked-up'],
    ['DELIVERED', 'delivered', 'delivered'],
    ['DELIVERY_FAILED', 'failed', 'exception'],
    ['RETURNING', 'returned', 'exception'],
    ['RETURNED', 'returned', 'exception'],
    ['CANCELLED', 'cancelled', 'cancelled'],
  ] as const)('maps %s to %s and progress %s', (raw, status, progress) => {
    expect(toFleetStatus(raw)).toBe(status);
    expect(progressOfFleetStatus(status)).toBe(progress);
  });

  it('knows no other word', () => {
    expect(toFleetStatus('TELEPORTED')).toBeNull();
    expect(toFleetStatus('picked_up')).toBeNull();
  });
});

describe('advanceBooking', () => {
  it('moves forward and raises the version', () => {
    const next = advanceBooking(
      booking(),
      { progress: 'picked-up', carrierStatus: 'PICKED_UP' },
      T1,
    );
    expect(next).toMatchObject({ progress: 'picked-up', carrierStatus: 'PICKED_UP', version: 2 });
    expect(next?.updatedAt).toEqual(T1);
  });

  it('keeps the progress but records a new status of the same rank', () => {
    expect(
      advanceBooking(booking(), { progress: 'booked', carrierStatus: 'ASSIGNED' }, T1),
    ).toMatchObject({ progress: 'booked', carrierStatus: 'ASSIGNED', version: 2 });
    expect(advanceBooking(booking(), { progress: 'booked', carrierStatus: 'SCHEDULED' }, T1)).toBe(
      null,
    );
  });

  it('never goes back, never leaves a final state, and ignores a cancel after pickup', () => {
    const pickedUp = booking({ progress: 'picked-up', carrierStatus: 'PICKED_UP' });
    expect(advanceBooking(pickedUp, { progress: 'booked', carrierStatus: 'ASSIGNED' }, T1)).toBe(
      null,
    );
    expect(
      advanceBooking(pickedUp, { progress: 'cancelled', carrierStatus: 'CANCELLED' }, T1),
    ).toBe(null);
    for (const final of ['delivered', 'exception', 'cancelled'] as const) {
      expect(isFinalProgress(final)).toBe(true);
      const done = booking({ progress: final, carrierStatus: 'X' });
      expect(advanceBooking(done, { progress: 'delivered', carrierStatus: 'DELIVERED' }, T1)).toBe(
        null,
      );
    }
    expect(
      advanceBooking(booking(), { progress: 'cancelled', carrierStatus: 'CANCELLED' }, T1),
    ).toMatchObject({ progress: 'cancelled' });
  });

  it('starts a booking of an unknown status as booked', () => {
    expect(booking({}).progress).toBe('booked');
    expect(newBooking({ ...booking(), carrierStatus: 'SOMETHING_NEW', now: T0 }).progress).toBe(
      'booked',
    );
  });
});

describe('fulfilmentStrategyFor', () => {
  const coverage = { serviceAreas: ['greater-brisbane', 'zz-central'] };
  it('is real-time only with a carrier and both ends in a served area', () => {
    expect(fulfilmentStrategyFor(coverage, 'greater-brisbane', 'greater-brisbane')).toBe(
      REAL_TIME_DELIVERY,
    );
    expect(fulfilmentStrategyFor(coverage, 'zz-central', 'zz-coast')).toBe(NO_CARRIER);
    expect(fulfilmentStrategyFor(coverage, null, 'zz-central')).toBe(NO_CARRIER);
    expect(fulfilmentStrategyFor(null, 'zz-central', 'zz-central')).toBe(NO_CARRIER);
    expect(fulfilmentStrategyFor({ serviceAreas: [] }, 'zz-central', 'zz-central')).toBe(
      NO_CARRIER,
    );
  });
});

describe('parseCarrierStop', () => {
  const stop = {
    contactName: ' Aisha Rahman ',
    contactPhone: '(04) 1234-5678',
    addressLines: ['12 Example Street', '', 'Sunnybank', 'QLD'],
    postcode: '4109',
    notes: 'Leave at\nthe door',
  };

  it('trims, drops empty lines and phone marks, and flattens line breaks in notes', () => {
    const parsed = parseCarrierStop(stop, 'dropoff');
    expect(parsed).toEqual({
      ok: true,
      stop: {
        contactName: 'Aisha Rahman',
        contactPhone: '04 12345678',
        addressLines: ['12 Example Street', 'Sunnybank', 'QLD'],
        postcode: '4109',
        locality: '',
        region: null,
        location: null,
        notes: 'Leave at the door',
      },
    });
    expect(parsed.ok && addressLineOf(parsed.stop)).toBe('12 Example Street, Sunnybank, QLD');
    expect(parseCarrierStop({ ...stop, notes: null, postcode: 'ZZ1 9AA' }, 'p')).toMatchObject({
      ok: true,
      stop: { notes: null, postcode: 'ZZ1 9AA' },
    });
  });

  it('keeps the locality, region and point of a saved address, and refuses a bad point', () => {
    expect(
      parseCarrierStop(
        { ...stop, locality: ' Sunnybank ', region: 'QLD', location: { lat: -27.58, lng: 153.06 } },
        'dropoff',
      ),
    ).toMatchObject({
      ok: true,
      stop: { locality: 'Sunnybank', region: 'QLD', location: { lat: -27.58, lng: 153.06 } },
    });
    expect(parseCarrierStop({ ...stop, location: { lat: 91, lng: 0 } }, 'dropoff')).toEqual({
      ok: false,
      fields: [{ path: 'dropoff.location', code: 'format' }],
    });
    expect(parseCarrierStop({ ...stop, locality: 'x'.repeat(121) }, 'dropoff')).toEqual({
      ok: false,
      fields: [{ path: 'dropoff.locality', code: 'format' }],
    });
  });

  it('names each bad field by its path only, never its value', () => {
    const parsed = parseCarrierStop(
      {
        contactName: 'x'.repeat(121),
        contactPhone: 'call me',
        addressLines: ['line\u0007one'],
        postcode: '<4109>',
        notes: 'n'.repeat(501),
      },
      'pickup',
    );
    expect(parsed).toEqual({
      ok: false,
      fields: [
        { path: 'pickup.contactName', code: 'format' },
        { path: 'pickup.contactPhone', code: 'format' },
        { path: 'pickup.addressLines', code: 'format' },
        { path: 'pickup.postcode', code: 'format' },
        { path: 'pickup.notes', code: 'format' },
      ],
    });
    expect(parseCarrierStop(null, 'd')).toMatchObject({ ok: false });
    expect(parseCarrierStop({ ...stop, addressLines: [] }, 'd')).toMatchObject({ ok: false });
    expect(parseCarrierStop({ ...stop, addressLines: Array(9).fill('a b c') }, 'd')).toMatchObject({
      ok: false,
    });
  });
});

describe('parseDriveWebhook', () => {
  const event = (overrides: Record<string, unknown> = {}, data: Record<string, unknown> = {}) =>
    new TextEncoder().encode(
      JSON.stringify({
        id: '01990000-0000-7000-8000-0000000000e1',
        type: 'delivery.status-changed',
        occurredAt: '2026-10-24T10:00:00Z',
        marketId: 'ZZ',
        data: {
          deliveryId: '01990000-0000-7000-8000-0000000000d1',
          externalReference: '01990000-0000-7000-8000-0000000000a1',
          status: 'PICKED_UP',
          previousStatus: 'AT_PICKUP',
          ...data,
        },
        ...overrides,
      }),
    );

  it('reads the ids, the Market and the status of the three delivery types', () => {
    for (const type of ['delivery.booked', 'delivery.status-changed', 'delivery.cancelled']) {
      expect(parseDriveWebhook(event({ type }))).toEqual({
        kind: 'delivery',
        event: {
          eventId: '01990000-0000-7000-8000-0000000000e1',
          marketId: 'ZZ',
          deliveryId: '01990000-0000-7000-8000-0000000000d1',
          externalReference: '01990000-0000-7000-8000-0000000000a1',
          status: 'PICKED_UP',
        },
      });
    }
    expect(parseDriveWebhook(event({ type: 'courier.location-updated' }))).toEqual({
      kind: 'other',
    });
  });

  it.each([
    ['not JSON', new TextEncoder().encode('{nope')],
    ['an array', new TextEncoder().encode('[]')],
    ['bad UTF-8', Uint8Array.from([0x7b, 0xff, 0x7d])],
    ['an upper-case id', event({ id: '01990000-0000-7000-8000-0000000000E1' })],
    ['a bad type', event({ type: 'Delivery!' })],
    ['a bad Market', event({ marketId: 'zz' })],
    ['no data', event({ data: null })],
    ['a bad reference', event({}, { externalReference: 'SO-1' })],
    ['a bad status', event({}, { status: 'picked up' })],
  ])('refuses %s', (_label, payload) => {
    expect(parseDriveWebhook(payload)).toEqual({ kind: 'invalid' });
  });
});
