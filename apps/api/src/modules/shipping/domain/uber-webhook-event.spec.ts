import { parseUberWebhook, toFleetStatus } from './uber-webhook-event';

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe('parseUberWebhook', () => {
  it('reads the event id, delivery id and status from the flat shape', () => {
    expect(
      parseUberWebhook(
        bytes({
          kind: 'event.delivery_status',
          id: 'evt_1',
          delivery_id: 'del_abcdefgh',
          status: 'Pickup_Complete',
        }),
      ),
    ).toEqual({
      kind: 'delivery',
      event: {
        eventId: 'evt_1',
        deliveryId: 'del_abcdefgh',
        status: 'pickup_complete',
        proofOfDelivery: false,
      },
    });
  });

  it('reads the nested shapes (data, meta) and the alternative names', () => {
    const nested = parseUberWebhook(
      bytes({
        event_type: 'event.delivery_status',
        event_id: 'e-2',
        data: { id: 'del_abcdefgh', status: 'delivered' },
      }),
    );
    const meta = parseUberWebhook(
      bytes({
        kind: 'event.delivery_status',
        id: 'e-3',
        meta: { resource_id: 'del_abcdefgh', status: 'pickup' },
      }),
    );
    expect(nested).toMatchObject({
      kind: 'delivery',
      event: { eventId: 'e-2', status: 'delivered' },
    });
    expect(meta).toMatchObject({
      kind: 'delivery',
      event: { deliveryId: 'del_abcdefgh', status: 'pickup' },
    });
  });

  it('flags a proof of delivery without reading it', () => {
    const parsed = parseUberWebhook(
      bytes({
        kind: 'event.delivery_status',
        id: 'e-4',
        delivery_id: 'del_abcdefgh',
        status: 'delivered',
        data: {
          verification: { picture: { image_url: 'https://x.example/p.jpg' }, recipient: 'Aisha' },
        },
      }),
    );
    expect(parsed).toEqual({
      kind: 'delivery',
      event: {
        eventId: 'e-4',
        deliveryId: 'del_abcdefgh',
        status: 'delivered',
        proofOfDelivery: true,
      },
    });
    expect(JSON.stringify(parsed)).not.toMatch(/Aisha|x\.example/);
  });

  it('drops another kind and refuses what is not an event', () => {
    expect(parseUberWebhook(bytes({ kind: 'event.courier_update', id: 'x' }))).toEqual({
      kind: 'other',
    });
    for (const bad of [
      new TextEncoder().encode('{'),
      new Uint8Array([0xff, 0xfe]),
      bytes([]),
      bytes(null),
      bytes({ kind: 'event.delivery_status' }),
      bytes({
        kind: 'event.delivery_status',
        id: 'a b',
        delivery_id: 'del_abcdefgh',
        status: 'pickup',
      }),
      bytes({
        kind: 'event.delivery_status',
        id: 'e',
        delivery_id: '../etc/passwd',
        status: 'pickup',
      }),
      bytes({
        kind: 'event.delivery_status',
        id: 'e',
        delivery_id: 'del_abcdefgh',
        status: 'PICK UP',
      }),
      bytes({ kind: 'event.delivery_status', id: 'e', delivery_id: 'del_abcdefgh', status: 3 }),
    ]) {
      expect(parseUberWebhook(bad)).toEqual({ kind: 'invalid' });
    }
  });
});

describe('toFleetStatus (Uber Direct)', () => {
  it.each([
    ['pending', 'pending'],
    ['pickup', 'assigned'],
    ['pickup_complete', 'picked_up'],
    ['dropoff', 'picked_up'],
    ['delivered', 'delivered'],
    ['canceled', 'cancelled'],
    ['returned', 'returned'],
    ['DELIVERED', 'delivered'],
  ])('maps %s to %s', (raw, expected) => {
    expect(toFleetStatus(raw)).toBe(expected);
  });
  it('answers null for a word it does not know', () => {
    expect(toFleetStatus('teleported')).toBeNull();
  });
});
