import { distribute, floorShare } from './allocation';

describe('floorShare', () => {
  it('floors an exact integer ratio', () => {
    expect(floorShare(1999n, 1000)).toBe(199n);
    expect(floorShare(0n, 5000)).toBe(0n);
    expect(floorShare(100n, 10000)).toBe(100n);
  });
});

describe('distribute', () => {
  const item = (id: string, weight: bigint, cap: bigint = weight) => ({ id, weight, cap });
  const sum = (m: ReadonlyMap<string, bigint>) => [...m.values()].reduce((a, b) => a + b, 0n);

  it('splits in proportion to the weights, with the remainder to the largest line', () => {
    const out = distribute(100n, [item('a', 1n, 99n), item('b', 1n, 99n), item('c', 1n, 99n)]);
    // 33 each; the remaining 1 goes to the first of the equal largest by id
    expect([...out.entries()]).toEqual([
      ['a', 34n],
      ['b', 33n],
      ['c', 33n],
    ]);
    expect(sum(out)).toBe(100n);
  });

  it('gives the remainder to the largest weight, not the first', () => {
    const out = distribute(10n, [item('a', 30n, 99n), item('b', 70n, 99n)]);
    expect(out.get('a')).toBe(3n);
    expect(out.get('b')).toBe(7n);
    const odd = distribute(11n, [item('a', 30n, 99n), item('b', 70n, 99n)]);
    // floor: 3 and 7, remainder 1 to b (largest)
    expect(odd.get('a')).toBe(3n);
    expect(odd.get('b')).toBe(8n);
  });

  it('breaks a tie between equal weights by the smaller id, whatever the input order', () => {
    const forward = distribute(5n, [item('a', 10n, 99n), item('b', 10n, 99n)]);
    const backward = distribute(5n, [item('b', 10n, 99n), item('a', 10n, 99n)]);
    expect(forward.get('a')).toBe(3n);
    expect(forward.get('b')).toBe(2n);
    expect(backward.get('a')).toBe(3n);
    expect(backward.get('b')).toBe(2n);
  });

  it('never gives a line more than its cap and moves the overflow to the next line with room', () => {
    const out = distribute(90n, [item('a', 50n, 10n), item('b', 50n, 100n)]);
    expect(out.get('a')).toBe(10n);
    expect(out.get('b')).toBe(80n);
  });

  it('gives at most the sum of the caps', () => {
    const out = distribute(1000n, [item('a', 10n), item('b', 20n)]);
    expect(sum(out)).toBe(30n);
  });

  it('gives nothing for a zero total or no lines', () => {
    expect(sum(distribute(0n, [item('a', 5n)]))).toBe(0n);
    expect(distribute(10n, []).size).toBe(0);
  });

  it('ignores lines with no room', () => {
    const out = distribute(10n, [item('a', 5n, 0n), item('b', 5n)]);
    expect(out.get('a')).toBe(0n);
    expect(out.get('b')).toBe(5n);
  });

  it('is exact for a spread of totals and weights', () => {
    for (let total = 0n; total <= 57n; total += 1n) {
      const out = distribute(total, [
        item('a', 7n, 99n),
        item('b', 13n, 99n),
        item('c', 1n, 99n),
        item('d', 29n, 99n),
      ]);
      expect(sum(out)).toBe(total);
    }
  });
});
