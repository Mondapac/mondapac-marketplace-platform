import { describe, expect, it } from 'vitest';
import { directionOf, keyResult, nameOf, typeAhead, visibleRows } from './tree-model.ts';
import type { CategoryRow } from './types.ts';

const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const row = (
  n: number,
  parent: number | null,
  depth: number,
  name: string,
  over: Partial<CategoryRow> = {},
): CategoryRow => ({
  id: id(n),
  parentId: parent === null ? null : id(parent),
  slug: `c-${n}`,
  status: 'active',
  mergedIntoId: null,
  names: [{ locale: 'en', name }],
  depth,
  position: 0,
  version: 1,
  counts: { liveProducts: 0, liveProductsDirect: 0, offers: 0 },
  ...over,
});
// Pantry > Rice > Basmati ; Pantry > Oils ; Drinks
const rows = [
  row(1, null, 0, 'Pantry'),
  row(2, 1, 1, 'Rice'),
  row(3, 2, 2, 'Basmati'),
  row(4, 1, 1, 'Oils', { status: 'archived' }),
  row(5, null, 0, 'Drinks'),
];
const none = { q: '', status: 'all' } as const;
const ids = (list: ReturnType<typeof visibleRows>) => list.map((e) => e.row.id);

describe('visibleRows', () => {
  it('lists only the rows whose ancestors are open', () => {
    expect(ids(visibleRows(rows, new Set(), none))).toEqual([id(1), id(5)]);
    expect(ids(visibleRows(rows, new Set([id(1)]), none))).toEqual([id(1), id(2), id(4), id(5)]);
    expect(ids(visibleRows(rows, new Set([id(1), id(2)]), none))).toEqual([
      id(1),
      id(2),
      id(3),
      id(4),
      id(5),
    ]);
  });

  it('a search lists the matches with their ancestors, all open, wherever they sit', () => {
    const list = visibleRows(rows, new Set(), { q: 'basm', status: 'all' });
    expect(ids(list)).toEqual([id(1), id(2), id(3)]);
    expect(list[0]?.expanded).toBe(true);
  });

  it('a status filter keeps the ancestors of a match', () => {
    expect(ids(visibleRows(rows, new Set(), { q: '', status: 'archived' }))).toEqual([
      id(1),
      id(4),
    ]);
  });

  it('numbers the siblings that are listed', () => {
    const list = visibleRows(rows, new Set([id(1)]), none);
    expect(list.map((e) => [e.posInSet, e.setSize])).toEqual([
      [1, 2],
      [1, 2],
      [2, 2],
      [2, 2],
    ]);
  });
});

describe('keyResult', () => {
  const open = visibleRows(rows, new Set([id(1), id(2)]), none);
  it('moves with the arrows, Home and End', () => {
    expect(keyResult(open, id(1), 'ArrowDown')).toEqual({ kind: 'focus', id: id(2) });
    expect(keyResult(open, id(2), 'ArrowUp')).toEqual({ kind: 'focus', id: id(1) });
    expect(keyResult(open, id(3), 'Home')).toEqual({ kind: 'focus', id: id(1) });
    expect(keyResult(open, id(1), 'End')).toEqual({ kind: 'focus', id: id(5) });
    expect(keyResult(open, id(5), 'ArrowDown')).toEqual({ kind: 'none' });
  });
  it('Right opens a closed branch then goes to the child; Left closes then goes to the parent', () => {
    const closed = visibleRows(rows, new Set(), none);
    expect(keyResult(closed, id(1), 'ArrowRight')).toEqual({ kind: 'expand', id: id(1) });
    expect(keyResult(open, id(1), 'ArrowRight')).toEqual({ kind: 'focus', id: id(2) });
    expect(keyResult(open, id(3), 'ArrowRight')).toEqual({ kind: 'none' });
    expect(keyResult(open, id(1), 'ArrowLeft')).toEqual({ kind: 'collapse', id: id(1) });
    expect(keyResult(open, id(3), 'ArrowLeft')).toEqual({ kind: 'focus', id: id(2) });
    expect(keyResult(open, id(5), 'ArrowLeft')).toEqual({ kind: 'none' });
  });
  it('* opens the siblings, an unknown row does nothing', () => {
    expect(keyResult(open, id(1), '*')).toEqual({ kind: 'expand-siblings', id: id(1) });
    expect(keyResult(open, id(99), 'ArrowDown')).toEqual({ kind: 'none' });
  });
});

describe('names and type-ahead', () => {
  it('falls back to the first locale, then the slug', () => {
    const fa = row(7, null, 0, 'x', { names: [{ locale: 'fa', name: 'برنج' }] });
    expect(nameOf(fa, 'en')).toBe('برنج');
    expect(nameOf(row(8, null, 0, 'x', { names: [] }), 'en')).toBe('c-8');
  });
  it('reads Persian and Arabic right to left', () => {
    expect(directionOf('fa')).toBe('rtl');
    expect(directionOf('ar-AE')).toBe('rtl');
    expect(directionOf('en')).toBe('ltr');
  });
  it('jumps to the next name that starts with the typed text, wrapping', () => {
    const open = visibleRows(rows, new Set([id(1), id(2)]), none);
    expect(typeAhead(open, id(1), 'd', 'en')).toBe(id(5));
    expect(typeAhead(open, id(5), 'p', 'en')).toBe(id(1));
    expect(typeAhead(open, id(1), 'zz', 'en')).toBeNull();
  });
});
