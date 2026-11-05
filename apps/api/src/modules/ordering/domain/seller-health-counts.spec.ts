import { Temporal } from '@mondapac/shared-kernel';
import { bucketSellerHealth, readyAgainstPromise, type ReadyRecord } from './seller-health-counts';

const PAID = Temporal.Instant.from('2026-11-02T01:00:00Z');
const WINDOW = {
  start: Temporal.Instant.from('2026-11-02T05:00:00Z'),
  end: Temporal.Instant.from('2026-11-02T07:00:00Z'),
};

const record = (extra: Partial<ReadyRecord>): ReadyRecord => ({
  readyAt: PAID.add({ minutes: 30 }),
  confirmedAt: PAID,
  deliveryMethod: 'instant',
  deliveryWindow: null,
  readyPrepMinutes: 60,
  ...extra,
});

describe('readyAgainstPromise', () => {
  it('is late only after the ready-by time, not at it', () => {
    const by = PAID.add({ minutes: 60 });
    expect(
      readyAgainstPromise([
        record({ readyAt: by.subtract({ minutes: 1 }) }),
        record({ readyAt: by }),
        record({ readyAt: by.add({ minutes: 1 }) }),
      ]),
    ).toEqual({ ready: 3, lateReady: 1 });
  });

  it('judges a scheduled order against its window start', () => {
    expect(
      readyAgainstPromise([
        record({ deliveryMethod: 'scheduled', deliveryWindow: WINDOW, readyAt: WINDOW.start }),
        record({
          deliveryMethod: 'scheduled',
          deliveryWindow: WINDOW,
          readyAt: WINDOW.start.add({ minutes: 5 }),
        }),
      ]),
    ).toEqual({ ready: 2, lateReady: 1 });
  });

  it('leaves out an order that carries no promise', () => {
    expect(
      readyAgainstPromise([
        record({ readyPrepMinutes: null, readyAt: PAID.add({ minutes: 600 }) }),
        record({}),
      ]),
    ).toEqual({ ready: 1, lateReady: 0 });
  });

  it('is empty for no orders', () => {
    expect(readyAgainstPromise([])).toEqual({ ready: 0, lateReady: 0 });
  });
});

describe('bucketSellerHealth', () => {
  const day1 = { from: PAID, to: PAID.add({ hours: 24 }) };
  const day2 = { from: PAID.add({ hours: 24 }), to: PAID.add({ hours: 48 }) };

  it('counts paid, ready and late orders per window, in the order of the windows', () => {
    const rows = {
      paidAt: [PAID, PAID.add({ hours: 5 }), PAID.add({ hours: 30 }), PAID.add({ hours: 60 })],
      ready: [
        record({ readyAt: PAID.add({ minutes: 59 }) }),
        record({ readyAt: PAID.add({ hours: 25 }), confirmedAt: PAID.add({ hours: 24 }) }),
        record({ readyAt: PAID.add({ hours: 27 }), confirmedAt: PAID.add({ hours: 24 }) }),
      ],
    };

    expect(bucketSellerHealth(rows, [day1, day2])).toEqual([
      { paid: 2, ready: 1, lateReady: 0 },
      { paid: 1, ready: 2, lateReady: 1 },
    ]);
  });

  it('puts an instant on the boundary into the later window only', () => {
    const rows = { paidAt: [day2.from], ready: [] };
    expect(bucketSellerHealth(rows, [day1, day2])).toEqual([
      { paid: 0, ready: 0, lateReady: 0 },
      { paid: 1, ready: 0, lateReady: 0 },
    ]);
  });
});
