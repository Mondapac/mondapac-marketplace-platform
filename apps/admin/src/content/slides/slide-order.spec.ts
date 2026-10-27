import { describe, expect, it } from 'vitest';
import {
  canMove,
  isReadable,
  move,
  orderBody,
  orderPageHref,
  orderReadPath,
  overLimitFlags,
  pinnedCount,
  placeFromSearch,
  sameOrder,
  saveFailureOf,
  type OrderEntry,
} from './slide-order.ts';

const CATEGORY = '0190a000-0000-7000-8000-0000000000c1';
const entry = (id: string, patch: Partial<OrderEntry> = {}): OrderEntry => ({
  id,
  internalName: `Slide ${id}`,
  status: 'live',
  pinned: false,
  startsAt: '2026-10-23T20:00:00Z',
  endsAt: '2026-10-26T13:59:00Z',
  overLimit: false,
  ...patch,
});
const ids = (list: readonly OrderEntry[]) => list.map((item) => item.id);

describe('place of the page', () => {
  it('opens at the first position of the catalogue with every page', () => {
    expect(placeFromSearch({})).toEqual({ position: 'home.hero', scope: 'all', scopeId: null });
  });

  it('keeps a known position, a scope it takes and a UUID', () => {
    expect(
      placeFromSearch({
        position: 'category.top',
        scope: 'category',
        scopeId: CATEGORY.toUpperCase(),
      }),
    ).toEqual({ position: 'category.top', scope: 'category', scopeId: CATEGORY });
  });

  it('falls back from an unknown position, a scope the position does not take and a bad id', () => {
    expect(placeFromSearch({ position: 'checkout.top' }).position).toBe('home.hero');
    expect(placeFromSearch({ position: 'home.mid', scope: 'category', scopeId: CATEGORY })).toEqual(
      { position: 'home.mid', scope: 'all', scopeId: null },
    );
    expect(placeFromSearch({ position: 'category.top', scope: 'everything' }).scope).toBe('all');
    expect(
      placeFromSearch({ position: 'category.top', scope: 'category', scopeId: 'x' }),
    ).toMatchObject({ scope: 'category', scopeId: null });
  });

  it('can be read only with the id of a scope other than all', () => {
    expect(isReadable({ position: 'home.hero', scope: 'all', scopeId: null })).toBe(true);
    expect(isReadable({ position: 'category.top', scope: 'category', scopeId: null })).toBe(false);
    expect(isReadable({ position: 'category.top', scope: 'category', scopeId: CATEGORY })).toBe(
      true,
    );
  });

  it('writes the page address and the API path with the same query', () => {
    const all = { position: 'home.hero', scope: 'all', scopeId: null } as const;
    expect(orderPageHref(all)).toBe('/content/slides/order?position=home.hero');
    expect(orderReadPath(all)).toBe('storefront/admin/slides/order?position=home.hero');
    const category = { position: 'category.top', scope: 'category', scopeId: CATEGORY } as const;
    expect(orderPageHref(category)).toBe(
      `/content/slides/order?position=category.top&scope=category&scopeId=${CATEGORY}`,
    );
    expect(orderReadPath(category)).toBe(
      `storefront/admin/slides/order?position=category.top&scope=category&scopeId=${CATEGORY}`,
    );
  });
});

describe('save body', () => {
  it('sends the place and every slide id in the order shown', () => {
    const list = [entry('a'), entry('b', { status: 'scheduled' })];
    expect(orderBody({ position: 'home.hero', scope: 'all', scopeId: null }, list)).toEqual({
      position: 'home.hero',
      scope: 'all',
      scopeId: null,
      slideIds: ['a', 'b'],
    });
    expect(
      orderBody({ position: 'category.top', scope: 'category', scopeId: CATEGORY }, list),
    ).toMatchObject({ scope: 'category', scopeId: CATEGORY });
  });
});

describe('moving', () => {
  const list = [entry('p', { pinned: true }), entry('a'), entry('b'), entry('c')];

  it('counts the pinned slides at the start', () => {
    expect(pinnedCount(list)).toBe(1);
    expect(pinnedCount([entry('a')])).toBe(0);
    expect(pinnedCount([entry('p', { pinned: true }), entry('q', { pinned: true })])).toBe(2);
  });

  it('locks pinned slides and the place right under them', () => {
    expect(canMove(list, 0, 'up')).toBe(false);
    expect(canMove(list, 0, 'down')).toBe(false);
    expect(canMove(list, 1, 'up')).toBe(false);
    expect(canMove(list, 1, 'down')).toBe(true);
    expect(canMove(list, 2, 'up')).toBe(true);
    expect(canMove(list, 3, 'down')).toBe(false);
    expect(canMove(list, 9, 'up')).toBe(false);
  });

  it('swaps two neighbours and leaves the pinned ones where they are', () => {
    expect(ids(move(list, 2, 'up'))).toEqual(['p', 'b', 'a', 'c']);
    expect(ids(move(list, 1, 'down'))).toEqual(['p', 'b', 'a', 'c']);
    expect(move(list, 1, 'up')).toBe(list);
    expect(move(list, 0, 'down')).toBe(list);
    expect(move(list, 3, 'down')).toBe(list);
  });

  it('does not change the list it was given', () => {
    move(list, 2, 'up');
    expect(ids(list)).toEqual(['p', 'a', 'b', 'c']);
  });

  it('compares two lists by id and place', () => {
    expect(sameOrder(list, [...list])).toBe(true);
    expect(sameOrder(list, move(list, 2, 'up'))).toBe(false);
    expect(sameOrder(list, list.slice(1))).toBe(false);
  });
});

describe('over the limit', () => {
  it('marks a live slide with the maximum or more live slides before it', () => {
    const list = ['a', 'b', 'c', 'd'].map((id) => entry(id));
    expect(overLimitFlags(list, 2)).toEqual([false, false, true, true]);
    expect(overLimitFlags(list, 4)).toEqual([false, false, false, false]);
  });

  it('never marks a scheduled slide, and counts only live slides toward the limit', () => {
    const list = [
      entry('s', { status: 'scheduled' }),
      entry('a'),
      entry('b'),
      entry('t', { status: 'scheduled' }),
    ];
    expect(overLimitFlags(list, 1)).toEqual([false, false, true, false]);
  });

  it('follows a move: the slide moved up takes the free place', () => {
    const list = ['a', 'b', 'c'].map((id) => entry(id));
    expect(overLimitFlags(move(list, 2, 'up'), 2)).toEqual([false, false, true]);
    expect(ids(move(list, 2, 'up'))).toEqual(['a', 'c', 'b']);
  });
});

describe('failed save', () => {
  it('reads a changed list from its code, whatever the status', () => {
    expect(saveFailureOf({ status: 409, code: 'storefront.slide-order-mismatch' })).toBe(
      'mismatch',
    );
  });

  it('reads a lost connection, a missing permission and an unknown error', () => {
    expect(saveFailureOf({ status: 0, code: 'network' })).toBe('network');
    expect(saveFailureOf({ status: 403, code: 'access.denied' })).toBe('denied');
    expect(saveFailureOf({ status: 500, code: 'unknown' })).toBe('generic');
  });

  it('reads a refused body: a slide that is not there, another field, or nothing named', () => {
    const fail = (fields: { path: string; code: string }[]) =>
      saveFailureOf({ status: 400, code: 'validation.failed', details: { fields } });
    expect(fail([{ path: 'slideIds[2]', code: 'not-found' }])).toBe('unknown-slide');
    expect(fail([{ path: 'scopeId', code: 'required' }])).toBe('invalid');
    expect(fail([])).toBe('generic');
  });
});
