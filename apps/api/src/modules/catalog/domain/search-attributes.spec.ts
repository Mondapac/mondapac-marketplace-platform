import { buildSearchAttributes, type SearchDefinition } from './search-attributes';
import { countryCodeOf, ISO_COUNTRIES } from './iso-countries';

const options = (
  entries: readonly (readonly [string, string, string | null])[],
): SearchDefinition['options'] =>
  new Map(
    entries.map(([code, label, mergedInto]) => [
      code,
      { labels: { 'en-AU': label }, mergedInto, active: true },
    ]),
  );

const definition = (overrides: Partial<SearchDefinition> = {}): SearchDefinition => ({
  dataType: 'select',
  localizable: false,
  status: 'active',
  searchable: true,
  canBeFilter: true,
  options: options([
    ['kg1', '1 kg', null],
    ['kg2', '2 kg', 'kg1'],
  ]),
  ...overrides,
});

const brand = { slug: 'al-safa', name: 'Al Safa', aliases: ['Alsafa'] };

describe('buildSearchAttributes', () => {
  it('indexes the brand with its aliases and the option label, and the option code as a facet', () => {
    const facts = buildSearchAttributes({
      values: { 'pack-size': 'kg1' },
      definitions: new Map([['pack-size', definition()]]),
      brand,
      locale: 'en-AU',
    });
    expect(facts.facets).toEqual(['brand=al-safa', 'pack-size=kg1']);
    expect(facts.searchText).toBe('Al Safa Alsafa 1 kg');
  });

  it('follows a merged option to its target', () => {
    const facts = buildSearchAttributes({
      values: { 'pack-size': 'kg2' },
      definitions: new Map([['pack-size', definition()]]),
      brand: null,
      locale: 'en-AU',
    });
    expect(facts.facets).toEqual(['pack-size=kg1']);
    expect(facts.searchText).toBe('1 kg');
  });

  it('leaves out drafts, unknown options and attributes that are neither searchable nor filters', () => {
    const facts = buildSearchAttributes({
      values: { a: 'kg1', b: 'nope', c: 'kg1', d: 'kg1' },
      definitions: new Map([
        ['a', definition({ status: 'draft' })],
        ['b', definition()],
        ['c', definition({ searchable: false, canBeFilter: false })],
        ['d', definition({ searchable: false })],
      ]),
      brand: null,
      locale: 'en-AU',
    });
    expect(facts.facets).toEqual(['d=kg1']);
    expect(facts.searchText).toBe('');
  });

  it('indexes multi-select values, yes only for booleans and numbers for range filters', () => {
    const facts = buildSearchAttributes({
      values: { diet: ['kg1', 'kg2'], organic: true, vegan: false, weight: '12.5', count: 3 },
      definitions: new Map([
        ['diet', definition({ dataType: 'multi-select', searchable: false })],
        ['organic', definition({ dataType: 'boolean' })],
        ['vegan', definition({ dataType: 'boolean' })],
        ['weight', definition({ dataType: 'decimal' })],
        ['count', definition({ dataType: 'integer' })],
      ]),
      brand: null,
      locale: 'en-AU',
    });
    expect(facts.facets).toEqual(['diet=kg1', 'organic=true']);
    expect(facts.numbers).toEqual({ weight: 12.5, count: 3 });
  });

  it('reads a localizable value in the document locale only', () => {
    const facts = buildSearchAttributes({
      values: { note: { 'en-AU': 'Stone ground', 'fa-IR': 'آسیاب سنگی' } },
      definitions: new Map([['note', definition({ dataType: 'text', localizable: true })]]),
      brand: null,
      locale: 'en-AU',
    });
    expect(facts.searchText).toBe('Stone ground');
  });

  it('turns the country of origin into one facet, from a code or a name', () => {
    for (const value of ['AU', 'au', 'Australia', ' united kingdom ', 'UK']) {
      const facts = buildSearchAttributes({
        values: { 'country-of-origin': value },
        definitions: new Map([
          [
            'country-of-origin',
            definition({ dataType: 'text', searchable: false, canBeFilter: false }),
          ],
        ]),
        brand: null,
        locale: 'en-AU',
      });
      expect(facts.facets).toHaveLength(1);
      expect(facts.facets[0]).toMatch(/^country-of-origin=[a-z]{2}$/);
    }
    const unknown = buildSearchAttributes({
      values: { 'country-of-origin': 'Atlantis' },
      definitions: new Map([['country-of-origin', definition({ dataType: 'text' })]]),
      brand: null,
      locale: 'en-AU',
    });
    expect(unknown.facets).toEqual([]);
  });
});

describe('ISO countries', () => {
  it('lists 249 distinct codes', () => {
    expect(new Set(ISO_COUNTRIES.map(([code]) => code)).size).toBe(249);
    expect(countryCodeOf('Australia')).toBe('au');
    expect(countryCodeOf('ZZ')).toBeNull();
    expect(countryCodeOf('Part of Australia')).toBeNull();
  });
});
