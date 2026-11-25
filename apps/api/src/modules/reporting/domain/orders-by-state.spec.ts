import { MAX_LISTED_STATES, ordersByStateOf } from './orders-by-state';

describe('ordersByStateOf', () => {
  it('holds back the shares below five paid orders', () => {
    expect(ordersByStateOf({ paid: 4, states: [{ state: 'QLD', orders: 4 }] })).toEqual({
      status: 'not-enough-data',
      paid: 4,
      minimum: 5,
    });
  });

  it('lists the biggest states first, ties by code, with the unknown apart', () => {
    const out = ordersByStateOf({
      paid: 10,
      states: [
        { state: 'VIC', orders: 3 },
        { state: 'NSW', orders: 3 },
        { state: 'QLD', orders: 3 },
      ],
    });
    expect(out).toEqual({
      status: 'available',
      paid: 10,
      states: [
        { state: 'NSW', orders: 3, shareBp: 3000 },
        { state: 'QLD', orders: 3, shareBp: 3000 },
        { state: 'VIC', orders: 3, shareBp: 3000 },
      ],
      other: null,
      unknown: { orders: 1, shareBp: 1000 },
    });
  });

  it('sums the states beyond the listed ones into other', () => {
    const states = Array.from({ length: MAX_LISTED_STATES + 2 }, (_, i) => ({
      state: `S${String(i).padStart(2, '0')}`,
      orders: 10 - i,
    }));
    const paid = states.reduce((sum, row) => sum + row.orders, 0);
    const out = ordersByStateOf({ paid, states });
    if (out.status !== 'available') throw new Error('expected available');
    expect(out.states).toHaveLength(MAX_LISTED_STATES);
    expect(out.other?.orders).toBe(2 + 1);
    expect(out.unknown).toBeNull();
  });

  it('refuses tallies that do not add up', () => {
    expect(() => ordersByStateOf({ paid: 5, states: [{ state: 'QLD', orders: 6 }] })).toThrow(
      RangeError,
    );
    expect(() => ordersByStateOf({ paid: -1, states: [] })).toThrow(RangeError);
  });

  it('shows shares at exactly five paid orders and drops zero-count states', () => {
    const out = ordersByStateOf({
      paid: 5,
      states: [
        { state: 'QLD', orders: 5 },
        { state: 'NSW', orders: 0 },
      ],
    });
    expect(out).toEqual({
      status: 'available',
      paid: 5,
      states: [{ state: 'QLD', orders: 5, shareBp: 10000 }],
      other: null,
      unknown: null,
    });
  });
});
