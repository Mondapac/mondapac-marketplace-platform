import { describe, expect, it } from 'vitest';
import type { VariantPrice } from '../price/types.ts';
import {
  increasedBy,
  savedPriceText,
  stockKey,
  writesOf,
  type TableRow,
} from './variants-table-logic.ts';

const price = (amount: string | null, retired = false): VariantPrice => ({
  variantId: 'v',
  seriesVersion: 1,
  currency: 'AUD',
  inForce: amount === null ? null : { amount, effectiveFrom: '2026-01-01T00:00:00Z' },
  held: null,
  special: null,
  heldSpecial: null,
  retired,
});
const row = (id: string, amount: string | null, onHand?: number, retired = false): TableRow => ({
  variantId: id,
  label: id,
  price: price(amount, retired),
  stock:
    onHand === undefined
      ? {}
      : { s1: { variantId: id, sourceId: 's1', onHand, held: 0, version: 2, retired: false } },
});

describe('increasedBy', () => {
  it('raises by a percent with exact integer maths, rounding half up', () => {
    expect(increasedBy('1999', '10')).toBe('2199'); // 2198.9 -> 2199
    expect(increasedBy('1000', '2.5')).toBe('1025');
    expect(increasedBy('5', '10')).toBe('6'); // 5.5 -> 6
    expect(increasedBy('4', '10')).toBe('4'); // 4.4 -> 4
    expect(increasedBy('1', '100')).toBe('2');
  });
  it('refuses a percent that is not 0.01 to 1000 with at most two decimals', () => {
    for (const bad of ['', '0', '0.00', '-5', 'abc', '1.234', '1001', '10%']) {
      expect(increasedBy('1000', bad)).toBeNull();
    }
    expect(increasedBy('', '10')).toBeNull();
    expect(increasedBy('12x', '10')).toBeNull();
  });
});

describe('writesOf', () => {
  const sources = [{ id: 's1' }, { id: 's2' }];
  it('sends only the cells whose draft differs from what was saved', () => {
    const rows = [row('a', '1999', 5), row('b', null, 0)];
    const result = writesOf(
      rows,
      sources,
      'AUD',
      { a: '19.99', b: '5' },
      { [stockKey('a', 's1')]: '7', [stockKey('a', 's2')]: '3', [stockKey('b', 's1')]: '0' },
    );
    expect(result.invalid).toEqual([]);
    expect(result.writes).toEqual([
      { kind: 'stock', variantId: 'a', sourceId: 's1', onHand: 7 },
      { kind: 'stock', variantId: 'a', sourceId: 's2', onHand: 3 },
      { kind: 'price', variantId: 'b', amount: '500' },
    ]);
  });
  it('returns an invalid draft and sends nothing for it', () => {
    const result = writesOf(
      [row('a', '1999', 5)],
      sources,
      'AUD',
      { a: '1.999' },
      {
        [stockKey('a', 's1')]: '-1',
      },
    );
    expect(result.writes).toEqual([]);
    expect(result.invalid).toEqual([
      { key: 'a', kind: 'price' },
      { key: stockKey('a', 's1'), kind: 'stock' },
    ]);
  });
  it('skips a retired variant', () => {
    expect(writesOf([row('a', '100', 1, true)], sources, 'AUD', { a: '2' }, {}).writes).toEqual([]);
  });
  it('reads the saved price in major units', () => {
    expect(savedPriceText(row('a', '1999'), 'AUD')).toBe('19.99');
    expect(savedPriceText(row('a', null), 'AUD')).toBe('');
  });
});
