import type { Id } from '@mondapac/shared-kernel';
import { Temporal } from '@mondapac/shared-kernel';
import {
  inTabOrder,
  isVisibleTo,
  mayManage,
  parseSavedFilterName,
  SAVED_FILTER_NAME_MAX,
} from './saved-filter';

const owner = '0190a000-0000-7000-8000-000000000001' as Id<'Account'>;
const other = '0190a000-0000-7000-8000-000000000002' as Id<'Account'>;

describe('parseSavedFilterName', () => {
  it('trims and keeps the case and inner spaces', () => {
    expect(parseSavedFilterName('  Meat,  Active ')).toEqual({ ok: true, value: 'Meat,  Active' });
  });

  it('counts characters, not UTF-16 units: 60 emoji fit, 61 do not', () => {
    expect(parseSavedFilterName('🥩'.repeat(SAVED_FILTER_NAME_MAX)).ok).toBe(true);
    expect(parseSavedFilterName('🥩'.repeat(SAVED_FILTER_NAME_MAX + 1)).ok).toBe(false);
  });

  it.each([
    [undefined, 'required'],
    [null, 'required'],
    ['', 'required'],
    ['   ', 'required'],
    [7, 'type'],
    ['x'.repeat(61), 'length'],
    ['a\nb', 'format'],
    ['a\u0000b', 'format'],
    ['a‮b', 'format'],
  ])('refuses %j as %s', (value, reason) => {
    expect(parseSavedFilterName(value)).toEqual({ ok: false, error: reason });
  });
});

describe('who may manage and see a filter', () => {
  it.each([
    ['the owner of a private filter', owner, 'me', false, true],
    ['the owner of a shared filter without the share key', owner, 'everyone', false, true],
    ['another admin with the key, on a shared filter', other, 'everyone', true, true],
    ['another admin without the key, on a shared filter', other, 'everyone', false, false],
    ['another admin with the key, on a private filter', other, 'me', true, false],
  ] as const)('%s', (_label, actor, visibility, canShare, expected) => {
    expect(mayManage({ ownerAccountId: owner, visibility }, actor, canShare)).toBe(expected);
  });

  it('shows a filter to its owner and, when shared, to everybody', () => {
    expect(isVisibleTo({ ownerAccountId: owner, visibility: 'me' }, owner)).toBe(true);
    expect(isVisibleTo({ ownerAccountId: owner, visibility: 'me' }, other)).toBe(false);
    expect(isVisibleTo({ ownerAccountId: owner, visibility: 'everyone' }, other)).toBe(true);
  });
});

describe('inTabOrder', () => {
  const at = (seconds: number) => Temporal.Instant.fromEpochMilliseconds(seconds * 1000);
  const row = (id: string, ownerAccountId: Id<'Account'>, position: number, seconds: number) => ({
    id: id as Id<'SavedFilter'>,
    ownerAccountId,
    position,
    createdAt: at(seconds),
  });

  it('puts the actor’s filters first by position, then the others oldest first', () => {
    const rows = [
      row('d', other, 1, 30),
      row('b', owner, 2, 20),
      row('c', other, 1, 10),
      row('a', owner, 1, 40),
    ];

    expect(inTabOrder(rows, owner).map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('does not change the array it is given', () => {
    const rows = [row('b', owner, 2, 1), row('a', owner, 1, 2)];

    inTabOrder(rows, owner);

    expect(rows.map((r) => r.id)).toEqual(['b', 'a']);
  });
});
