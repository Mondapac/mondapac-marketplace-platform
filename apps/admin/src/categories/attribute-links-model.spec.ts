import { describe, expect, it } from 'vitest';
import {
  draftOf,
  filterChoices,
  labelOf,
  linksErrorKey,
  moveFilter,
  sameDraft,
  type AttributeOption,
  type LinksBody,
} from './attribute-links-model.ts';

const attribute = (code: string, over: Partial<AttributeOption> = {}): AttributeOption => ({
  code,
  dataType: 'select',
  status: 'active',
  names: { 'en-AU': code },
  ...over,
});

describe('attribute links model', () => {
  it('names an attribute in the default locale, else the first name, else the code', () => {
    expect(labelOf({ 'en-AU': 'Origin', fa: 'مبدا' }, 'en-AU', 'origin')).toBe('Origin');
    expect(labelOf({ fa: 'مبدا' }, 'en-AU', 'origin')).toBe('مبدا');
    expect(labelOf({}, 'en-AU', 'origin')).toBe('origin');
    expect(labelOf(null, 'en-AU', 'origin')).toBe('origin');
  });

  it('starts the draft from what the category holds itself', () => {
    const body = {
      categoryId: 'c1',
      own: { featureSetId: 'fs1', filters: ['a', 'b'], revisionNo: 2, version: 3 },
      effective: { featureSet: null, filters: [] },
    } satisfies LinksBody;
    expect(draftOf(body)).toEqual({ featureSetId: 'fs1', filters: ['a', 'b'] });
    expect(draftOf({ ...body, own: null })).toEqual({ featureSetId: null, filters: [] });
  });

  it('tells a changed draft from an unchanged one', () => {
    const a = { featureSetId: null, filters: ['a', 'b'] };
    expect(sameDraft(a, { featureSetId: null, filters: ['a', 'b'] })).toBe(true);
    expect(sameDraft(a, { featureSetId: null, filters: ['b', 'a'] })).toBe(false);
    expect(sameDraft(a, { featureSetId: 'x', filters: ['a', 'b'] })).toBe(false);
  });

  it('moves a filter by one place and stops at the ends', () => {
    expect(moveFilter(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveFilter(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
    expect(moveFilter(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
    expect(moveFilter(['a', 'b'], 1, 1)).toEqual(['a', 'b']);
  });

  it('offers only active attributes of a filterable type that are not listed yet', () => {
    const list = [
      attribute('colour'),
      attribute('notes', { dataType: 'text' }),
      attribute('old', { status: 'archived' }),
      attribute('size', { dataType: 'decimal' }),
      attribute('organic', { dataType: 'boolean' }),
      attribute('weight', { dataType: 'measure' }),
    ];
    expect(filterChoices(list, new Set(['organic'])).map((a) => a.code)).toEqual([
      'colour',
      'size',
    ]);
  });

  it('maps a refused save to one message', () => {
    expect(linksErrorKey(409, 'category-links.stale')).toBe('stale');
    expect(linksErrorKey(422, 'category-links.filter-not-filterable')).toBe(
      'filter-not-filterable',
    );
    expect(linksErrorKey(422, 'category-links.too-many-filters')).toBe('too-many');
    expect(linksErrorKey(0, 'network')).toBe('network');
    expect(linksErrorKey(500, 'whatever')).toBe('unknown');
  });
});
