import { describe, expect, it } from 'vitest';
import {
  MAX_PRODUCT_CATEGORIES,
  addCategory,
  choiceLabel,
  choiceParts,
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
