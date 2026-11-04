import { describe, expect, it } from 'vitest';
import {
  canPickMore,
  edgeActive,
  filterOptions,
  moveActive,
  normalizeForSearch,
  pickedFirst,
  showsSearch,
  togglePick,
  type SearchSelectOption,
} from './search-select-logic.ts';

const o = (value: string, label = value, extra: Partial<SearchSelectOption> = {}) => ({
  value,
  label,
  ...extra,
});

describe('filterOptions', () => {
  const options = [
    o('1', 'Café au lait', { description: 'Drinks › Coffee' }),
    o('2', 'Butcher'),
    o('3', 'Frozen meat', { description: 'Food › Meat › Frozen' }),
  ];

  it('returns every option for an empty or blank query', () => {
    expect(filterOptions(options, '')).toBe(options);
    expect(filterOptions(options, '   ')).toBe(options);
  });

  it('ignores case and accents and matches the description (the category path)', () => {
    expect(filterOptions(options, 'CAFE').map((x) => x.value)).toEqual(['1']);
    expect(filterOptions(options, 'coffee').map((x) => x.value)).toEqual(['1']);
    expect(filterOptions(options, 'meat').map((x) => x.value)).toEqual(['3']);
  });

  it('needs every word of the query', () => {
    expect(filterOptions(options, 'meat frozen').map((x) => x.value)).toEqual(['3']);
    expect(filterOptions(options, 'meat butcher')).toEqual([]);
  });

  it('normalises text for search', () => {
    expect(normalizeForSearch('  Crème Brûlée ')).toBe('creme brulee');
  });
});

describe('pickedFirst', () => {
  const options = [o('a'), o('b'), o('c')];

  it('keeps the order when nothing is picked', () => {
    expect(pickedFirst(options, [])).toBe(options);
  });

  it('puts the picks first in the order picked, then the rest', () => {
    expect(pickedFirst(options, [o('c'), o('a')]).map((x) => x.value)).toEqual(['c', 'a', 'b']);
  });

  it('keeps a pick that the current list does not hold (server search)', () => {
    expect(pickedFirst([o('x')], [o('gone', 'Gone')]).map((x) => x.value)).toEqual(['gone', 'x']);
  });
});

describe('moveActive and edgeActive', () => {
  const options = [o('a'), o('b', 'b', { disabled: true }), o('c')];

  it('skips disabled rows and wraps around', () => {
    expect(moveActive(options, 0, 1)).toBe(2);
    expect(moveActive(options, 2, 1)).toBe(0);
    expect(moveActive(options, 0, -1)).toBe(2);
    expect(moveActive(options, 2, -1)).toBe(0);
  });

  it('starts at the first row going down and at the last going up', () => {
    expect(moveActive(options, -1, 1)).toBe(0);
    expect(moveActive(options, -1, -1)).toBe(2);
  });

  it('answers -1 when no row can be active', () => {
    expect(moveActive([], -1, 1)).toBe(-1);
    expect(moveActive([o('a', 'a', { disabled: true })], -1, 1)).toBe(-1);
    expect(edgeActive([], 'first')).toBe(-1);
  });

  it('finds the first and last enabled row', () => {
    expect(edgeActive(options, 'first')).toBe(0);
    expect(edgeActive([o('a', 'a', { disabled: true }), o('b')], 'first')).toBe(1);
    expect(edgeActive(options, 'last')).toBe(2);
  });
});

describe('picking under a cap', () => {
  it('adds, removes and stops at the cap', () => {
    const one = togglePick([], o('a'), 2);
    const two = togglePick(one, o('b'), 2);
    expect(two.map((x) => x.value)).toEqual(['a', 'b']);
    expect(togglePick(two, o('c'), 2)).toBe(two);
    expect(togglePick(two, o('a'), 2).map((x) => x.value)).toEqual(['b']);
    expect(canPickMore(two, 2)).toBe(false);
    expect(canPickMore(two, undefined)).toBe(true);
  });
});

describe('showsSearch', () => {
  it('shows from the threshold, always for a growing list, and for server search', () => {
    const base = { threshold: 8, always: false, server: false };
    expect(showsSearch({ ...base, optionCount: 7 })).toBe(false);
    expect(showsSearch({ ...base, optionCount: 8 })).toBe(true);
    expect(showsSearch({ ...base, optionCount: 2, always: true })).toBe(true);
    expect(showsSearch({ ...base, optionCount: 2, server: true })).toBe(true);
  });
});
