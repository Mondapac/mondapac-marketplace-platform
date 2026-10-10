import type { Id } from '@mondapac/shared-kernel';
import { AllocationPolicy, type AllocationRequest } from './allocation-policy';

const id = <K extends string>(n: number) =>
  `0199c1a0-0000-7000-8000-${String(n).padStart(12, '0')}` as Id<K>;

const request = (n: number, quantity: number, sellables: readonly number[]): AllocationRequest => ({
  offerId: id(n),
  variantId: id(n + 100),
  quantity,
  candidates: sellables.map((sellable, at) => ({
    stockItemId: id(n * 10 + at),
    sellable,
  })),
});

describe('AllocationPolicy (design 4.2 step 6)', () => {
  it('takes the first source in priority order that fits the whole line', () => {
    const result = AllocationPolicy.allocate([request(1, 3, [2, 5, 9])]);

    expect(result).toEqual({
      ok: true,
      allocations: [expect.objectContaining({ stockItemId: id(11), quantity: 3 })],
    });
  });

  it('never splits a line across sources (Q3)', () => {
    const result = AllocationPolicy.allocate([request(1, 4, [2, 3])]);

    expect(result).toEqual({
      ok: false,
      failures: [{ offerId: id(1), variantId: id(101), reason: 'not-enough' }],
    });
  });

  it('answers out when nothing is left on any source', () => {
    expect(AllocationPolicy.allocate([request(1, 1, [0, 0])])).toMatchObject({
      ok: false,
      failures: [{ reason: 'out' }],
    });
    expect(AllocationPolicy.allocate([request(1, 1, [])])).toMatchObject({
      ok: false,
      failures: [{ reason: 'out' }],
    });
  });

  it('is all or nothing: one failing line allocates none and names every failing line', () => {
    const result = AllocationPolicy.allocate([
      request(1, 1, [5]),
      request(2, 9, [5]),
      request(3, 9, [0]),
    ]);

    expect(result).toEqual({
      ok: false,
      failures: [
        { offerId: id(2), variantId: id(102), reason: 'not-enough' },
        { offerId: id(3), variantId: id(103), reason: 'out' },
      ],
    });
  });
});
