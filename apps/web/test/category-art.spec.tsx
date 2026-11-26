import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CATEGORY_ART } from '../src/icons/category-art.tsx';
import { CategoryArt, categoryArtOf } from '../src/icons/category-icon.tsx';
import { departmentsOf } from '../src/storefront/departments.ts';

// The stand-in picture of a product without a photo (owner's choice 26 Nov 2026, set A): the
// illustration of the product's department, or the general one.

const id = (n: number) => `0b5e1c3a-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('department of a category id', () => {
  const rows = [
    { id: id(1), parentId: null, slug: 'seafood' },
    { id: id(2), parentId: id(1), slug: 'fish' },
    { id: id(3), parentId: id(2), slug: 'fish-fillets' },
    { id: id(4), parentId: null, slug: 'drinks' },
    { id: id(5), parentId: id(4), slug: 'tea-and-coffee' },
  ];

  it('walks every level up to the top-level category, whatever the row order', () => {
    const departments = departmentsOf(rows);
    expect(departments.get(id(3))).toBe('seafood');
    expect(departments.get(id(2))).toBe('seafood');
    expect(departments.get(id(1))).toBe('seafood');
    expect(departments.get(id(5))).toBe('drinks');
    expect(departmentsOf([...rows].reverse()).get(id(3))).toBe('seafood');
  });

  it('stops at a parent the tree lacks and survives a loop in a broken answer', () => {
    const departments = departmentsOf([
      { id: id(6), parentId: id(99), slug: 'orphan' },
      { id: id(7), parentId: id(8), slug: 'a' },
      { id: id(8), parentId: id(7), slug: 'b' },
    ]);
    expect(departments.get(id(6))).toBe('orphan');
    expect(departments.get(id(7))).toBeDefined();
    expect(departments.get(id(8))).toBeDefined();
  });
});

describe('category illustration', () => {
  it.each([
    'meat',
    'poultry',
    'seafood',
    'bakery',
    'pantry',
    'dairy',
    'produce',
    'spices',
    'meals',
    'sweets-and-snacks',
    'drinks',
    'household',
  ])('has its own illustration for the %s department', (code) => {
    expect(Object.hasOwn(CATEGORY_ART, code)).toBe(true);
    expect(categoryArtOf(code)).toBe(CATEGORY_ART[code]);
  });

  it.each(['', 'fish-fillets', 'constructor', '9f1c-unknown'])(
    'gives the general illustration to %j',
    (code) => {
      expect(categoryArtOf(code)).toBe(CATEGORY_ART.general);
    },
  );

  it('is a decorative colour picture, never the line icon', () => {
    const html = renderToStaticMarkup(<CategoryArt code="" />);
    expect(html).toContain('class="vec"');
    expect(html).toContain('aria-hidden="true"');
  });
});
