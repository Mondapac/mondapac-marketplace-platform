import type { Id } from '@mondapac/shared-kernel';
import { categoryNamesOf, composeSearchText, MAX_SEARCH_TEXT_CHARS } from './index-names';
import type { NamedCategory } from './scope-counts';

const cat = (n: number) =>
  `00000000-0000-7000-8000-${String(n).padStart(12, '0')}` as Id<'Category'>;
const tree: NamedCategory[] = [
  { id: cat(1), parentId: null, name: 'Meat' },
  { id: cat(2), parentId: cat(1), name: 'Beef' },
  { id: cat(3), parentId: cat(2), name: 'Mince' },
  { id: cat(4), parentId: null, name: 'Pantry' },
];

describe('categoryNamesOf', () => {
  it('names the category and every level above it, once', () => {
    expect(categoryNamesOf([cat(3)], tree)).toBe('Mince Beef Meat');
    expect(categoryNamesOf([cat(3), cat(2), cat(4)], tree)).toBe('Mince Beef Meat Pantry');
  });
  it('skips a category the tree does not hold', () => {
    expect(categoryNamesOf([cat(9)], tree)).toBe('');
  });
});

describe('composeSearchText', () => {
  it('puts the store and category names before the attribute words', () => {
    expect(composeSearchText('halal Australia', "Ali's Butcher", 'Mince Beef')).toBe(
      "Ali's Butcher Mince Beef halal Australia",
    );
  });
  it('is null when there is nothing to search', () => {
    expect(composeSearchText('', null, '')).toBeNull();
  });
  it('never exceeds the column limit and keeps the names when the attribute words are long', () => {
    const text = composeSearchText('w '.repeat(3000), 'Store', 'Cat');
    expect(text).not.toBeNull();
    expect([...text!].length).toBeLessThanOrEqual(MAX_SEARCH_TEXT_CHARS);
    expect(text!.startsWith('Store Cat w')).toBe(true);
  });
});
