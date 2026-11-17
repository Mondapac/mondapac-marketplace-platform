import { describe, expect, it } from 'vitest';
import { writerCategory } from './writer-inputs.ts';

const categories = [
  { categoryId: 'a', parentId: null, names: { en: 'Pantry' } },
  { categoryId: 'b', parentId: 'a', names: { en: 'Rice' } },
  { categoryId: 'c', parentId: null, names: { en: 'Drinks' } },
];

describe('writerCategory', () => {
  it('sends the primary category: the first one listed, as its path', () => {
    expect(writerCategory(categories, ['b', 'c'], 'en')).toBe('Pantry › Rice');
    expect(writerCategory(categories, ['c', 'b'], 'en')).toBe('Drinks');
  });

  it('does not fall back to a later category when the primary one is unknown', () => {
    expect(writerCategory(categories, ['zz', 'c'], 'en')).toBe('');
    expect(writerCategory(categories, [], 'en')).toBe('');
  });
});
