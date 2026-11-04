import {
  definitionRecord,
  featureSetRecord,
  revisionRecord,
} from '../../../../../test/support/catalog-attribute-admin-fakes';
import {
  changesBetween,
  listFilterOf,
  marketLocalesOf,
  matchesFilter,
  missingLocalesOf,
  pageOf,
  usesOf,
} from './attribute-admin-views';

// The pure parts of the admin attribute reads (attributes plan, package A1): the closed filters,
// the "Missing" locales, the feature-set uses, the search, the keyset page and the history diff.

const ID = (n: number) => `01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const LOCALES = marketLocalesOf({ default: 'en-AU', supported: ['fa-AU', 'en-AU'] });

describe('admin attribute views', () => {
  it('puts the default locale first, once', () => {
    expect(LOCALES).toEqual({ default: 'en-AU', supported: ['en-AU', 'fa-AU'] });
  });

  describe('listFilterOf', () => {
    it('reads every filter, trimming the search and ignoring empty values', () => {
      expect(
        listFilterOf(
          { search: '  Net ', type: 'select', status: 'active', usedIn: ID(1), missing: 'fa-AU' },
          LOCALES,
        ),
      ).toEqual({
        ok: true,
        value: {
          search: 'Net',
          dataType: 'select',
          status: 'active',
          usedIn: ID(1),
          missing: 'fa-AU',
        },
      });
      expect(listFilterOf({ search: '', type: '', missing: null }, LOCALES)).toEqual({
        ok: true,
        value: { search: null, dataType: null, status: null, usedIn: null, missing: null },
      });
    });

    it.each([
      [{ search: 3 }, 'search', 'type'],
      [{ search: 'x'.repeat(121) }, 'search', 'too-long'],
      [{ type: 'image' }, 'type', 'unknown'],
      [{ status: 'deleted' }, 'status', 'unknown'],
      [{ usedIn: 'not-an-id' }, 'usedIn', 'format'],
      [{ missing: 'de-DE' }, 'missing', 'unknown'],
    ])('refuses %j', (input, path, code) => {
      expect(listFilterOf(input, LOCALES)).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path, code }] },
      });
    });
  });

  it('marks a locale missing when the name or an active value label lacks it', () => {
    const named = { names: { 'en-AU': 'Size', 'fa-AU': 'اندازه' } };
    expect(missingLocalesOf({ ...named, options: [] }, LOCALES)).toEqual([]);
    expect(missingLocalesOf({ names: { 'en-AU': 'Size' }, options: [] }, LOCALES)).toEqual([
      'fa-AU',
    ]);
    const option = (active: boolean) => ({
      code: 'small',
      labels: { 'en-AU': 'Small' },
      active,
      position: 0,
    });
    expect(missingLocalesOf({ ...named, options: [option(true)] }, LOCALES)).toEqual(['fa-AU']);
    // An inactive value is not offered any more: its missing label does not count.
    expect(missingLocalesOf({ ...named, options: [option(false)] }, LOCALES)).toEqual([]);
  });

  it('finds every group of every feature set that names a code', () => {
    const sets = [
      featureSetRecord(ID(10), 'default', [
        {
          groupCode: 'general',
          attributes: [{ code: 'brand', required: true, isVariantOption: false }],
        },
        {
          groupCode: 'pack',
          attributes: [{ code: 'pack-size', required: false, isVariantOption: true }],
        },
      ]),
      featureSetRecord(ID(11), 'rice', [
        {
          groupCode: 'core',
          attributes: [{ code: 'brand', required: false, isVariantOption: false }],
        },
      ]),
    ];
    expect(usesOf('brand', sets)).toEqual([
      {
        featureSetId: ID(10),
        featureSetCode: 'default',
        featureSetStatus: 'active',
        groupCode: 'general',
        required: true,
        isVariantOption: false,
      },
      {
        featureSetId: ID(11),
        featureSetCode: 'rice',
        featureSetStatus: 'active',
        groupCode: 'core',
        required: false,
        isVariantOption: false,
      },
    ]);
    expect(usesOf('colour', sets)).toEqual([]);
  });

  it('matches the search in the code or any name, case- and accent-insensitive', () => {
    const definition = definitionRecord(ID(1), 'country-of-origin', {
      names: { 'en-AU': 'Country of Origin', 'fa-AU': 'کشور سازنده' },
    });
    const filter = { search: null, dataType: null, status: null, usedIn: null, missing: null };
    const match = (search: string) => matchesFilter(definition, { ...filter, search }, [], LOCALES);
    expect(match('ORIGIN')).toBe(true);
    expect(match('country-of')).toBe(true);
    expect(match('کشور')).toBe(true);
    expect(match('orígin')).toBe(true);
    expect(match('weight')).toBe(false);
    expect(matchesFilter(definition, { ...filter, dataType: 'select' }, [], LOCALES)).toBe(false);
    expect(matchesFilter(definition, { ...filter, status: 'archived' }, [], LOCALES)).toBe(false);
    // A feature set that is not the Market's matches nothing.
    expect(matchesFilter(definition, { ...filter, usedIn: ID(99) as never }, [], LOCALES)).toBe(
      false,
    );
  });

  it('pages after an id, and answers an empty last page for a lost cursor', () => {
    const rows = [1, 2, 3, 4, 5].map((n) => ({ id: ID(n) }));
    expect(pageOf(rows, null, 2)).toEqual({ items: [rows[0], rows[1]], nextAfterId: ID(2) });
    expect(pageOf(rows, ID(2), 2)).toEqual({ items: [rows[2], rows[3]], nextAfterId: ID(4) });
    expect(pageOf(rows, ID(4), 2)).toEqual({ items: [rows[4]], nextAfterId: null });
    expect(pageOf(rows, ID(99), 2)).toEqual({ items: [], nextAfterId: null });
    expect(pageOf(rows, null, 5)).toEqual({ items: rows, nextAfterId: null });
  });

  it('lists the field-by-field changes between two revisions', () => {
    const before = revisionRecord(ID(20), 1, {
      names: { 'en-AU': 'Pack size' },
      bounds: {},
      options: [
        { code: 'g250', labels: { 'en-AU': '250 g' }, active: true, position: 0 },
        { code: 'g500', labels: { 'en-AU': '500 g' }, active: true, position: 1 },
      ],
    });
    const after = revisionRecord(ID(21), 2, {
      names: { 'en-AU': 'Pack size', 'fa-AU': 'اندازهٔ بسته' },
      material: true,
      options: [
        { code: 'g250', labels: { 'en-AU': '250 grams' }, active: false, position: 0 },
        { code: 'g500', labels: { 'en-AU': '500 g' }, active: true, position: 1 },
        { code: 'kg1', labels: { 'en-AU': '1 kg' }, active: true, position: 2 },
      ],
    });
    expect(changesBetween(before, after)).toEqual([
      { field: 'name.fa-AU', before: null, after: 'اندازهٔ بسته' },
      { field: 'material', before: false, after: true },
      { field: 'option.g250.label.en-AU', before: '250 g', after: '250 grams' },
      { field: 'option.g250.active', before: true, after: false },
      { field: 'option.kg1.added', before: null, after: true },
    ]);
    expect(changesBetween(before, before)).toEqual([]);
  });
});
