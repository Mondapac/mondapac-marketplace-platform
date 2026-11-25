import { describe, expect, it } from 'vitest';
import type { VariantPrice } from '../price/types.ts';
import {
  costKey,
  costWritesOf,
  increasedBy,
  savedCostText,
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

describe('writesOf: equivalent values are not writes', () => {
  const sources = [{ id: 's1' }];
  it('skips "10" for a saved 10.00 and "05" for a saved 5', () => {
    const result = writesOf(
      [row('v1', '1000', 5)],
      sources,
      'AUD',
      { v1: '10' },
      { 'v1:s1': '05' },
    );
    expect(result).toEqual({ writes: [], invalid: [] });
  });
  it('still writes a real change', () => {
    const result = writesOf(
      [row('v1', '1000', 5)],
      sources,
      'AUD',
      { v1: '10.5' },
      { 'v1:s1': '6' },
    );
    expect(result.writes).toHaveLength(2);
  });
  it('works for a currency without minor units (second market fixture, JPY)', () => {
    const jpy = { ...row('v1', '1500', 5), price: { ...price('1500'), currency: 'JPY' } };
    expect(savedPriceText(jpy, 'JPY')).toBe('1500');
    expect(writesOf([jpy], sources, 'JPY', { v1: '1500' }, {}).writes).toEqual([]);
    expect(writesOf([jpy], sources, 'JPY', { v1: '1600' }, {}).writes).toEqual([
      { kind: 'price', variantId: 'v1', amount: '1600' },
    ]);
    expect(writesOf([jpy], sources, 'JPY', { v1: '15.5' }, {}).invalid).toHaveLength(1);
    expect(increasedBy('1500', '10')).toBe('1650');
    expect(increasedBy('1', '1000')).toBe('11');
    expect(increasedBy('1', '0.01')).toBe('1');
  });
});

describe('increasedBy bounds', () => {
  it('accepts 1000 and refuses 1000.01', () => {
    expect(increasedBy('100', '1000')).toBe('1100');
    expect(increasedBy('100', '1000.01')).toBeNull();
  });
});

describe('costWritesOf (Offer page PR 7-UI)', () => {
  const rows = [row('v1', '1000'), row('v2', '2000'), row('v3', null), row('v4', '500', 0, true)];
  const saved = {
    v1: { amount: '900' },
    v2: { amount: null },
    v3: { amount: null },
    v4: { amount: '100' },
  };

  it('sends a typed Cost that differs from the recorded one, and clears an emptied one', () => {
    expect(costWritesOf(rows, 'AUD', { v1: '9.5', v2: '12' }, saved)).toEqual({
      writes: [
        { kind: 'cost', variantId: 'v1', amount: '950' },
        { kind: 'cost', variantId: 'v2', amount: '1200' },
      ],
      invalid: [],
    });
    expect(costWritesOf(rows, 'AUD', { v1: ' ' }, saved).writes).toEqual([
      { kind: 'cost', variantId: 'v1', amount: null },
    ]);
  });

  it('sends nothing for the same Cost, an empty field with none recorded, or a retired size', () => {
    expect(costWritesOf(rows, 'AUD', { v1: '9', v2: '', v4: '3' }, saved)).toEqual({
      writes: [],
      invalid: [],
    });
  });

  it('skips a size the Cost read did not answer for, and names text that is not money', () => {
    expect(costWritesOf(rows, 'AUD', { v1: '0', v2: '9.999', v9: '5' }, saved)).toEqual({
      writes: [],
      invalid: [
        { key: costKey('v1'), kind: 'cost' },
        { key: costKey('v2'), kind: 'cost' },
      ],
    });
  });

  it('shows the recorded Cost in major units', () => {
    expect(savedCostText({ amount: '900' }, 'AUD')).toBe('9.00');
    expect(savedCostText({ amount: null }, 'AUD')).toBe('');
    expect(savedCostText(undefined, 'AUD')).toBe('');
  });
});
