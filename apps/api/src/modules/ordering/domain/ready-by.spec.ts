import { Temporal } from '@mondapac/shared-kernel';
import { readyByOf } from './order';

const PAID = Temporal.Instant.from('2026-11-02T01:00:00Z');
const START = Temporal.Instant.from('2026-11-05T02:00:00Z');
const END = Temporal.Instant.from('2026-11-05T04:00:00Z');

describe('readyByOf', () => {
  it('is the payment time plus the frozen minutes', () => {
    const by = readyByOf(
      { confirmedAt: PAID },
      { deliveryMethod: 'instant', deliveryWindow: null, readyPrepMinutes: 90 },
    );
    expect(by?.toString()).toBe('2026-11-02T02:30:00Z');
  });

  it('is the window start for a scheduled order', () => {
    const by = readyByOf(
      { confirmedAt: PAID },
      {
        deliveryMethod: 'scheduled',
        deliveryWindow: { start: START, end: END },
        readyPrepMinutes: 90,
      },
    );
    expect(by?.toString()).toBe(START.toString());
  });

  it('is null before payment and for an order placed without minutes', () => {
    const sellerOrder = {
      deliveryMethod: 'same_day' as const,
      deliveryWindow: null,
      readyPrepMinutes: 60,
    };
    expect(readyByOf({ confirmedAt: null }, sellerOrder)).toBeNull();
    expect(readyByOf({ confirmedAt: PAID }, { ...sellerOrder, readyPrepMinutes: null })).toBeNull();
  });
});
