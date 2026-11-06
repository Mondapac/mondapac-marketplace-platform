import {
  buildSearchAttributes,
  buildVariantFacets,
  variantLabelOf,
  withVariantWords,
  type SearchDefinition,
} from './search-attributes';
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

  it('indexes a merged attribute as its target, with the value mapped', () => {
    const target = definition({
      options: options([
        ['tin', 'Tin', null],
        ['jar', 'Jar', null],
      ]),
    });
    const source = definition({
      status: 'archived',
      options: options([['can', 'Can', null]]),
      mergedInto: { code: 'container', options: new Map([['can', 'tin']]) },
    });
    const definitions = new Map([
      ['container', target],
      ['pack-type', source],
    ]);
    const facts = buildSearchAttributes({
      values: { 'pack-type': 'can' },
      definitions,
      brand: null,
      locale: 'en-AU',
    });
    expect(facts.facets).toEqual(['container=tin']);
    expect(facts.searchText).toBe('Tin');
    // The target's own value wins when the product carries both.
    expect(
      buildSearchAttributes({
        values: { 'pack-type': 'can', container: 'jar' },
        definitions,
        brand: null,
        locale: 'en-AU',
      }).facets,
    ).toEqual(['container=jar']);
  });

  it('maps a merged multi-select without duplicates and carries numbers to the target', () => {
    const multi = (overrides: Partial<SearchDefinition>) =>
      definition({ dataType: 'multi-select', ...overrides });
    const target = multi({ options: options([['tin', 'Tin', null]]) });
    const source = multi({
      status: 'archived',
      options: options([
        ['can', 'Can', null],
        ['tub', 'Tub', null],
      ]),
      mergedInto: {
        code: 'container',
        options: new Map([
          ['can', 'tin'],
          ['tub', 'tin'],
        ]),
      },
    });
    expect(
      buildSearchAttributes({
        values: { 'pack-type': ['can', 'tub', 'gone'] },
        definitions: new Map([
          ['container', target],
          ['pack-type', source],
        ]),
        brand: null,
        locale: 'en-AU',
      }).facets,
    ).toEqual(['container=tin']);
    const weight = definition({ dataType: 'decimal', options: new Map() });
    const oldWeight = definition({
      dataType: 'decimal',
      status: 'archived',
      options: new Map(),
      mergedInto: { code: 'net-weight', options: new Map() },
    });
    expect(
      buildSearchAttributes({
        values: { weight: '12.5' },
        definitions: new Map([
          ['net-weight', weight],
          ['weight', oldWeight],
        ]),
        brand: null,
        locale: 'en-AU',
      }).numbers,
    ).toEqual({ 'net-weight': 12.5 });
  });

  it('leaves out a merged attribute whose target is not active or whose value has no target value', () => {
    const source = definition({
      status: 'archived',
      options: options([['can', 'Can', null]]),
      mergedInto: { code: 'container', options: new Map([['can', 'tin']]) },
    });
    const index = (target: SearchDefinition | undefined, values: Record<string, unknown>) =>
      buildSearchAttributes({
        values,
        definitions: new Map([
          ['pack-type', source],
          ...(target === undefined ? [] : [['container', target] as const]),
        ]),
        brand: null,
        locale: 'en-AU',
      }).facets;
    const live = definition({ options: options([['tin', 'Tin', null]]) });
    expect(index(undefined, { 'pack-type': 'can' })).toEqual([]);
    expect(index({ ...live, status: 'archived' }, { 'pack-type': 'can' })).toEqual([]);
    expect(index(live, { 'pack-type': 'unknown' })).toEqual([]);
  });

  it('leaves out an archived attribute, like a draft one', () => {
    const facts = buildSearchAttributes({
      values: { a: 'kg1' },
      definitions: new Map([['a', definition({ status: 'archived', searchable: true })]]),
      brand: null,
      locale: 'en-AU',
    });
    expect(facts.facets).toEqual([]);
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

describe('variant facets and labels (variants V8)', () => {
  it('indexes an axis value as its option code, following a merged option', () => {
    const definitions = new Map([['weight', definition()]]);
    expect(buildVariantFacets({ optionValues: { weight: 'kg1' }, definitions })).toEqual([
      'weight=kg1',
    ]);
    expect(buildVariantFacets({ optionValues: { weight: 'kg2' }, definitions })).toEqual([
      'weight=kg1',
    ]);
  });

  it('follows a merged attribute to its active target', () => {
    const definitions = new Map([
      [
        'tin-size',
        definition({ mergedInto: { code: 'weight', options: new Map([['s', 'kg1']]) } }),
      ],
      ['weight', definition()],
    ]);
    expect(buildVariantFacets({ optionValues: { 'tin-size': 's' }, definitions })).toEqual([
      'weight=kg1',
    ]);
  });

  it('leaves out an unknown option, an inactive or non-filter definition and a non-choice type', () => {
    const cases: [Record<string, unknown>, Map<string, SearchDefinition>][] = [
      [{ weight: 'nope' }, new Map([['weight', definition()]])],
      [{ weight: 'kg1' }, new Map([['weight', definition({ status: 'archived' })]])],
      [{ weight: 'kg1' }, new Map([['weight', definition({ canBeFilter: false })]])],
      [{ weight: 'kg1' }, new Map([['weight', definition({ dataType: 'text' })]])],
      [{ other: 'kg1' }, new Map([['weight', definition()]])],
    ];
    for (const [optionValues, definitions] of cases) {
      expect(buildVariantFacets({ optionValues, definitions })).toEqual([]);
    }
  });

  it('reads a label in the locale, else English, else null', () => {
    expect(variantLabelOf({ 'en-AU': '1 kg', 'fa-IR': '۱ کیلو' }, 'fa-IR')).toBe('۱ کیلو');
    expect(variantLabelOf({ 'en-AU': '1 kg' }, 'ja-JP')).toBe('1 kg');
    expect(variantLabelOf({ 'fa-IR': '۱ کیلو' }, 'ja-JP')).toBe(null);
    expect(variantLabelOf(null, 'en-AU')).toBe(null);
  });

  it('adds labels to the search text once, within the limit', () => {
    expect(withVariantWords('Al Safa', ['1 kg', '10 kg', null, '1 kg'])).toBe('Al Safa 1 kg 10 kg');
    expect(withVariantWords('', ['1 kg'])).toBe('1 kg');
    expect([...withVariantWords('x', ['y'.repeat(3000)])].length).toBe(2000);
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
