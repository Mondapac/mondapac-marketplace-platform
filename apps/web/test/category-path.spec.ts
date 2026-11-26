import { describe, expect, it } from 'vitest';
import { categoryTrailOf, pathOf, type CategoryNode } from '../src/storefront/category-path.ts';

// A product's breadcrumb from the ids the API sends. The live tree has three levels
// (department > aisle > category); products sit on the third.

const MEAT = '0b5e1c3a-0000-4000-8000-000000000001';
const LAMB = '0b5e1c3a-0000-4000-8000-000000000002';
const ROASTS = '0b5e1c3a-0000-4000-8000-000000000003';
const DRINKS = '0b5e1c3a-0000-4000-8000-000000000004';
const TEA = '0b5e1c3a-0000-4000-8000-000000000005';
const LOOP_A = '0b5e1c3a-0000-4000-8000-0000000000a1';
const LOOP_B = '0b5e1c3a-0000-4000-8000-0000000000a2';
const GONE = '0b5e1c3a-0000-4000-8000-0000000000ff';

const ROWS: CategoryNode[] = [
  { id: MEAT, parentId: null, slug: 'meat', name: 'Meat' },
  { id: LAMB, parentId: MEAT, slug: 'lamb', name: 'Lamb' },
  { id: ROASTS, parentId: LAMB, slug: 'lamb-roasts', name: 'Lamb roasts' },
  { id: DRINKS, parentId: null, slug: 'drinks', name: 'Drinks' },
  { id: TEA, parentId: DRINKS, slug: 'tea', name: 'Tea' },
  { id: LOOP_A, parentId: LOOP_B, slug: 'loop-a', name: 'A' },
  { id: LOOP_B, parentId: LOOP_A, slug: 'loop-b', name: 'B' },
];

describe('category path', () => {
  it('walks from a level-3 category up to its department', () => {
    expect(pathOf(ROWS, ROASTS).map((n) => n.slug)).toEqual(['meat', 'lamb', 'lamb-roasts']);
    expect(pathOf(ROWS, GONE)).toEqual([]);
  });

  it('stops at a loop instead of running forever', () => {
    expect(pathOf(ROWS, LOOP_A).map((n) => n.slug)).toEqual(['loop-b', 'loop-a']);
  });

  it("builds a product's breadcrumb from the first id the tree knows", () => {
    expect(categoryTrailOf(ROWS, [GONE, 7, ROASTS, TEA])).toEqual([
      { code: 'meat', name: 'Meat' },
      { code: 'lamb', name: 'Lamb' },
      { code: 'lamb-roasts', name: 'Lamb roasts' },
    ]);
    expect(categoryTrailOf(ROWS, [GONE])).toBeUndefined();
    expect(categoryTrailOf([], [ROASTS])).toBeUndefined();
  });
});
