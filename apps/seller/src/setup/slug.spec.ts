import { describe, expect, it } from 'vitest';
import { slugFormatOk, suggestSlug } from './slug.ts';

describe('suggestSlug', () => {
  it.each([
    ['Kuraby Fresh', 'kuraby-fresh'],
    ['  Café  Naïve & Co. ', 'cafe-naive-co'],
    ['---', ''],
    ['A'.repeat(80), 'a'.repeat(50)],
    [`${'a'.repeat(49)} b`, 'a'.repeat(49)],
  ])('turns %j into %j', (name, slug) => {
    expect(suggestSlug(name)).toBe(slug);
  });
});

describe('slugFormatOk', () => {
  it.each([
    ['abc', true],
    ['kuraby-fresh', true],
    ['ab', false],
    ['-abc', false],
    ['abc-', false],
    ['a--b', false],
    ['ABC', false],
    ['a_b', false],
    ['a'.repeat(51), false],
  ])('%j is %s', (slug, ok) => {
    expect(slugFormatOk(slug)).toBe(ok);
  });
});
