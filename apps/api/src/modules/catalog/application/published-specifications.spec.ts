import {
  MAX_SPECIFICATIONS,
  publishedSpecificationsOf,
  type SpecificationDefinition,
} from './published-specifications';

const LOCALES = { requested: 'fa-IR', fallback: 'en-AU' };

const define = (
  code: string,
  dataType: string,
  extra: Partial<SpecificationDefinition> = {},
): [string, SpecificationDefinition] => [
  code,
  {
    code,
    dataType,
    localizable: false,
    names: { 'en-AU': code[0]!.toUpperCase() + code.slice(1) },
    options: new Map<string, Record<string, string>>(),
    ...extra,
  },
];

const GROUPS = [
  { groupCode: 'general', attributes: [{ code: 'brand' }, { code: 'description' }] },
  {
    groupCode: 'details',
    attributes: [{ code: 'origin' }, { code: 'weight' }, { code: 'organic' }, { code: 'pack' }],
  },
  { groupCode: 'extra', attributes: [{ code: 'tags' }] },
];

const DEFINITIONS = new Map([
  define('brand', 'text'),
  define('description', 'long-text', { localizable: true }),
  define('origin', 'text', { localizable: true, names: { 'en-AU': 'Origin', 'fa-IR': 'مبدا' } }),
  define('weight', 'decimal'),
  define('organic', 'boolean'),
  define('pack', 'select', {
    options: new Map<string, Record<string, string>>([
      ['g250', { 'en-AU': '250 g' }],
      ['kg1', { 'en-AU': '1 kg', 'fa-IR': '۱ کیلو' }],
    ]),
  }),
  define('tags', 'multi-select', {
    options: new Map<string, Record<string, string>>([
      ['a', { 'en-AU': 'Fresh' }],
      ['b', { 'en-AU': 'Local' }],
    ]),
  }),
]);

describe('publishedSpecificationsOf', () => {
  it('groups by the family order, names and options in the locale with English fallback', () => {
    const result = publishedSpecificationsOf(
      GROUPS,
      DEFINITIONS,
      {
        origin: { 'en-AU': 'Queensland', 'fa-IR': 'کوئینزلند' },
        weight: '1.6',
        organic: false,
        pack: 'kg1',
        tags: ['b', 'a'],
      },
      LOCALES,
    );
    expect(result).toEqual([
      {
        groupCode: 'details',
        items: [
          { code: 'origin', name: 'مبدا', value: { kind: 'text', text: 'کوئینزلند' } },
          { code: 'weight', name: 'Weight', value: { kind: 'text', text: '1.6' } },
          { code: 'organic', name: 'Organic', value: { kind: 'boolean', value: false } },
          { code: 'pack', name: 'Pack', value: { kind: 'text', text: '۱ کیلو' } },
        ],
      },
      {
        groupCode: 'extra',
        items: [{ code: 'tags', name: 'Tags', value: { kind: 'list', items: ['Local', 'Fresh'] } }],
      },
    ]);
  });

  it('falls back to English when the locale has no text', () => {
    const result = publishedSpecificationsOf(
      GROUPS,
      DEFINITIONS,
      { origin: { 'en-AU': 'Queensland' }, pack: 'g250' },
      LOCALES,
    );
    expect(result[0]!.items).toEqual([
      { code: 'origin', name: 'مبدا', value: { kind: 'text', text: 'Queensland' } },
      { code: 'pack', name: 'Pack', value: { kind: 'text', text: '250 g' } },
    ]);
  });

  it('leaves out the brand, long texts, empty values, unknown options and empty groups', () => {
    const result = publishedSpecificationsOf(
      GROUPS,
      DEFINITIONS,
      {
        brand: 'Acme',
        description: { 'en-AU': 'Long' },
        origin: { 'fa-IR': '  ' },
        weight: '',
        organic: 'yes',
        pack: 'gone',
        tags: [],
      },
      LOCALES,
    );
    expect(result).toEqual([]);
  });

  it('leaves out an attribute that has no definition or no name, and a value never stored', () => {
    const definitions = new Map(DEFINITIONS);
    definitions.set('weight', { ...DEFINITIONS.get('weight')!, names: {} });
    definitions.delete('organic');
    const result = publishedSpecificationsOf(
      GROUPS,
      definitions,
      { weight: '2', organic: true },
      LOCALES,
    );
    expect(result).toEqual([]);
  });

  it('shows integers and dates as text with Latin digits', () => {
    const definitions = new Map([define('count', 'integer'), define('best', 'date')]);
    const result = publishedSpecificationsOf(
      [{ groupCode: 'details', attributes: [{ code: 'count' }, { code: 'best' }] }],
      definitions,
      { count: 12, best: '2027-01-31' },
      LOCALES,
    );
    expect(result[0]!.items.map((i) => i.value)).toEqual([
      { kind: 'text', text: '12' },
      { kind: 'text', text: '2027-01-31' },
    ]);
  });

  it('is cut at the maximum', () => {
    const codes = Array.from({ length: MAX_SPECIFICATIONS + 5 }, (_, i) => `a${i}`);
    const definitions = new Map(codes.map((code) => define(code, 'integer')));
    const values = Object.fromEntries(codes.map((code, i) => [code, i]));
    const result = publishedSpecificationsOf(
      [{ groupCode: 'details', attributes: codes.map((code) => ({ code })) }],
      definitions,
      values,
      LOCALES,
    );
    expect(result.flatMap((g) => g.items)).toHaveLength(MAX_SPECIFICATIONS);
  });
});
