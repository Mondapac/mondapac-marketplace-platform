import { describe, expect, it } from 'vitest';
import {
  MAX_PRODUCT_CATEGORIES,
  addCategory,
  choiceLabel,
  choiceParts,
  choicesInBranch,
  dropOutOfBranch,
  focusAfterRemove,
  splitLabel,
  makePrimary,
  removeCategory,
  type CategoryChoice,
} from './category-chooser-logic.ts';

const choice = (over: Partial<CategoryChoice> = {}): CategoryChoice => ({
  id: 'c1',
  level: 4,
  name: 'Basmati',
  path: ['Pantry', 'Rice', 'Basmati'],
  general: false,
  status: 'active',
  ...over,
});

describe('choiceLabel', () => {
  it('joins the path', () => {
    expect(choiceLabel(choice(), 'General')).toBe('Pantry › Rice › Basmati');
  });
  it('ends a general choice in the word for it', () => {
    expect(
      choiceLabel(
        choice({ level: 3, name: 'Rice', path: ['Pantry', 'Rice'], general: true }),
        'General',
      ),
    ).toBe('Pantry › Rice › General');
  });
  it('falls back to the name when the path is empty', () => {
    expect(choiceLabel(choice({ path: [] }), 'General')).toBe('Basmati');
  });
});

describe('the list rules', () => {
  it('moves the chosen one to the front and keeps the order of the others', () => {
    expect(makePrimary(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b']);
    expect(makePrimary(['a', 'b'], 'a')).toEqual(['a', 'b']);
    expect(makePrimary(['a'], 'x')).toEqual(['a']);
  });
  it('removes one and promotes the next when the primary goes', () => {
    expect(removeCategory(['a', 'b', 'c'], 'a')).toEqual(['b', 'c']);
  });
  it('adds at the end, ignoring a duplicate and a fourth', () => {
    expect(MAX_PRODUCT_CATEGORIES).toBe(3);
    expect(addCategory(['a'], 'b')).toEqual(['a', 'b']);
    expect(addCategory(['a'], 'a')).toEqual(['a']);
    expect(addCategory(['a', 'b', 'c'], 'd')).toEqual(['a', 'b', 'c']);
  });
});

describe('parts and focus', () => {
  it('splits a choice and a label into the same names', () => {
    expect(choiceParts(choice({ general: true }), 'General')).toEqual([
      'Pantry',
      'Rice',
      'Basmati',
      'General',
    ]);
    expect(splitLabel('Pantry › Rice')).toEqual(['Pantry', 'Rice']);
  });
  it('picks the next row, else the previous, else the Add control', () => {
    expect(focusAfterRemove(['a', 'b', 'c'], 'b')).toEqual({ kind: 'row', id: 'c' });
    expect(focusAfterRemove(['a', 'b'], 'b')).toEqual({ kind: 'row', id: 'a' });
    expect(focusAfterRemove(['a'], 'a')).toEqual({ kind: 'add' });
  });
});

describe('same-branch rules', () => {
  const at = (id: string, ...path: string[]): CategoryChoice => ({
    id,
    level: path.length,
    name: path[path.length - 1] ?? '',
    path,
    general: false,
    status: 'active',
  });
  const all = [at('a1', 'Pantry', 'Rice'), at('a2', 'Pantry', 'Oils'), at('b1', 'Drinks', 'Tea')];
  it('offers only the primary department once there is a primary', () => {
    expect(choicesInBranch(all, []).map((c) => c.id)).toEqual(['a1', 'a2', 'b1']);
    expect(choicesInBranch(all, ['b1']).map((c) => c.id)).toEqual(['b1']);
    expect(choicesInBranch(all, ['a1', 'b1']).map((c) => c.id)).toEqual(['a1', 'a2']);
    expect(choicesInBranch(all, ['unknown']).map((c) => c.id)).toEqual(['a1', 'a2', 'b1']);
  });
  it('drops the others that left the primary department and keeps unknown ids', () => {
    expect(dropOutOfBranch(['b1', 'a1', 'a2'], all)).toEqual({ ids: ['b1'], dropped: 2 });
    expect(dropOutOfBranch(['a1', 'a2', 'x'], all)).toEqual({ ids: ['a1', 'a2', 'x'], dropped: 0 });
    expect(dropOutOfBranch([], all)).toEqual({ ids: [], dropped: 0 });
  });
  it('prefers the department id over the name, and falls back to the name', () => {
    const d1 = { ...at('c1', 'Same', 'Rice'), departmentId: 'dep-1' };
    const d2 = { ...at('c2', 'Same', 'Tea'), departmentId: 'dep-2' };
    expect(choicesInBranch([d1, d2], ['c1']).map((c) => c.id)).toEqual(['c1']);
    expect(dropOutOfBranch(['c1', 'c2'], [d1, d2])).toEqual({ ids: ['c1'], dropped: 1 });
    // Without ids two departments of one name count as one (client only; the API is the authority).
    const n1 = at('n1', 'Same', 'Rice');
    const n2 = at('n2', 'Same', 'Tea');
    expect(dropOutOfBranch(['n1', 'n2'], [n1, n2])).toEqual({ ids: ['n1', 'n2'], dropped: 0 });
  });
});
