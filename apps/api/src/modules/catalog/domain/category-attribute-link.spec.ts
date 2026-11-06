import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId } from '@mondapac/shared-kernel';
import {
  CATEGORY_FILTERS_MAX,
  CategoryAttributeLink,
  resolveEffective,
  type LinkFact,
} from './category-attribute-link';

const NOW = Temporal.Instant.from('2026-11-03T00:00:00Z');
const LATER = Temporal.Instant.from('2026-11-04T00:00:00Z');
const make = (filters: readonly string[], familyId: string | null = null) =>
  CategoryAttributeLink.create({
    marketId: 'AU' as MarketId,
    categoryId: 'c1' as Id<'Category'>,
    revisionId: 'r1' as Id<'CategoryAttributeLinkRevision'>,
    familyId: familyId as Id<'AttributeFamily'> | null,
    filters,
    now: NOW,
  });

describe('CategoryAttributeLink', () => {
  it('starts at version 1 and keeps the filter order', () => {
    const result = make(['colour', 'size'], 'f1');
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.state).toMatchObject({
      version: 1,
      revisionNo: 1,
      familyId: 'f1',
      filters: ['colour', 'size'],
    });
  });

  it('revises into the next version without touching the first', () => {
    const first = make(['colour']);
    if (!first.ok) throw new Error(first.error.code);
    const next = first.value.revise({
      revisionId: 'r2' as Id<'CategoryAttributeLinkRevision'>,
      familyId: null,
      filters: ['size', 'colour'],
      now: LATER,
    });
    if (!next.ok) throw new Error(next.error.code);
    expect(next.value.state).toMatchObject({
      version: 2,
      revisionNo: 2,
      filters: ['size', 'colour'],
    });
    expect(next.value.state.revisedAt).toEqual(LATER);
    expect(next.value.state.createdAt).toEqual(NOW);
    expect(first.value.state.filters).toEqual(['colour']);
  });

  it.each([
    ['a bad code', ['Colour'], 'category-links.filter-invalid'],
    ['a repeated code', ['colour', 'colour'], 'category-links.filter-repeated'],
    [
      'too many filters',
      Array.from({ length: CATEGORY_FILTERS_MAX + 1 }, (_, i) => `f${i}`),
      'category-links.too-many-filters',
    ],
  ])('refuses %s', (_name, filters, code) => {
    const result = make(filters);
    expect(result.ok ? 'ok' : result.error.code).toBe(code);
  });
});

describe('resolveEffective', () => {
  const links = new Map<string, LinkFact>([
    ['dept', { familyId: 'f-dept' as Id<'AttributeFamily'>, filters: ['brand', 'organic'] }],
    ['group', { familyId: null, filters: ['organic', 'size'] }],
    ['leaf', { familyId: 'f-leaf' as Id<'AttributeFamily'>, filters: ['colour'] }],
  ]);
  const linkOf = (id: string) => links.get(id);

  it('takes the nearest feature set, itself first', () => {
    expect(resolveEffective(['leaf', 'group', 'dept'], linkOf)).toMatchObject({
      familyId: 'f-leaf',
      familyFromCategoryId: 'leaf',
    });
    expect(resolveEffective(['group', 'dept'], linkOf)).toMatchObject({
      familyId: 'f-dept',
      familyFromCategoryId: 'dept',
    });
  });

  it('lists ancestors first, keeps each order and a code once', () => {
    expect(resolveEffective(['leaf', 'group', 'dept'], linkOf).filters).toEqual([
      { code: 'brand', fromCategoryId: 'dept' },
      { code: 'organic', fromCategoryId: 'dept' },
      { code: 'size', fromCategoryId: 'group' },
      { code: 'colour', fromCategoryId: 'leaf' },
    ]);
  });

  it('answers no feature set and no filters when nobody up the chain holds any', () => {
    expect(resolveEffective(['x', 'y'], () => undefined)).toEqual({
      familyId: null,
      familyFromCategoryId: null,
      filters: [],
    });
  });
});
