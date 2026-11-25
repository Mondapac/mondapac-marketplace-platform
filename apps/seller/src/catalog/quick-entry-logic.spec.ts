import { describe, expect, it } from 'vitest';
import { afterSellPath } from './add-offer-dialog.tsx';
import { inBatches, moreOf, QUICK_MAX, quickIdsOf, sizeStatusOf } from './quick-entry-logic.ts';
import type { TableRow } from './variants-table-logic.ts';

const ID = (n: number) => `0190aaaa-0000-7000-8000-${String(n).padStart(12, '0')}`;

const row = (amount: string | null, onHand?: number, retired = false): TableRow => ({
  variantId: 'v1',
  label: '1 kg',
  price: {
    variantId: 'v1',
    seriesVersion: null,
    currency: 'AUD',
    inForce: amount === null ? null : { amount, effectiveFrom: '2026-01-01T00:00:00Z' },
    held: null,
    special: null,
    heldSpecial: null,
    retired,
  },
  stock:
    onHand === undefined
      ? {}
      : { s1: { variantId: 'v1', sourceId: 's1', onHand, held: 0, version: 1, retired: false } },
});

describe('sizeStatusOf', () => {
  const status = (
    r: TableRow,
    prices: Record<string, string> = {},
    stocks: Record<string, string> = {},
    sources = ['s1'],
  ) => sizeStatusOf(r, 'AUD', sources, prices, stocks);

  it('asks for a price first, then stock', () => {
    expect(status(row(null))).toBe('needs-price');
    expect(status(row(null), { v1: '17.9' })).toBe('needs-stock');
    expect(status(row(null), { v1: '17.9' }, { 'v1:s1': '25' })).toBe('ready');
    expect(status(row('1790', 0))).toBe('out-of-stock');
    expect(status(row('1790', 3))).toBe('ready');
  });
  it('flags text that is not a price or a whole number', () => {
    expect(status(row(null), { v1: 'abc' })).toBe('check-price');
    expect(status(row('1790'), {}, { 'v1:s1': '2.5' })).toBe('check-stock');
  });
  it('judges the typed value over the saved one, and adds the locations', () => {
    expect(status(row('1790', 3), { v1: '' })).toBe('needs-price');
    expect(status(row('1790', 0), {}, { 'v1:s2': '4' }, ['s1', 's2'])).toBe('ready');
  });
  it('does not judge stock the seller cannot see, nor a size that is no longer sold', () => {
    expect(status(row('1790'), {}, {}, [])).toBe('ready');
    expect(status(row('1790', 0, true))).toBe('not-sold');
  });
});

describe('quick entry address', () => {
  it('opens one draft on its Offer and several in the table', () => {
    expect(afterSellPath([ID(1)])).toBe(`/offers/${ID(1)}?new=1#sizes`);
    expect(afterSellPath([ID(1), ID(2)])).toBe(`/offers/new?ids=${ID(1)},${ID(2)}`);
    const many = Array.from({ length: QUICK_MAX + 3 }, (_, i) => ID(i));
    const path = afterSellPath(many);
    expect(path.endsWith('&more=3')).toBe(true);
    expect(quickIdsOf(new URLSearchParams(path.split('?')[1]).get('ids') ?? '', QUICK_MAX)).toEqual(
      many.slice(0, QUICK_MAX),
    );
  });
  it('reads only UUIDs, once each, up to the limit', () => {
    expect(quickIdsOf(`${ID(1)},x,${ID(1)},../a,${ID(2)}`, 20)).toEqual([ID(1), ID(2)]);
    expect(quickIdsOf([ID(1), ID(2)], 1)).toEqual([ID(1)]);
    expect(quickIdsOf(undefined, 20)).toEqual([]);
  });
  it('reads the count of drafts beyond the table', () => {
    expect(moreOf('3')).toBe(3);
    expect(moreOf('-1')).toBe(0);
    expect(moreOf('99999999')).toBe(0);
    expect(moreOf(undefined)).toBe(0);
  });
});

describe('inBatches', () => {
  it('reads a few at a time and answers in order', async () => {
    let running = 0;
    let most = 0;
    const read = async (n: number) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;
      return n * 2;
    };
    expect(await inBatches([1, 2, 3, 4, 5, 6, 7, 8, 9], 4, read)).toEqual([
      2, 4, 6, 8, 10, 12, 14, 16, 18,
    ]);
    expect(most).toBe(4);
  });
});
