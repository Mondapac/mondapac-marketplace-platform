import {
  parseActivityContent,
  suggestActivityCode,
  isActivityCode,
  tidyActivityText,
} from './business-activity';

const LOCALES = { required: 'en', supported: ['en', 'ar', 'fa'] };
const CATEGORY = '01990000-0000-7000-8000-000000000001';

describe('parseActivityContent', () => {
  it('accepts the required name with optional ones, a description and categories', () => {
    const result = parseActivityContent(
      {
        names: { en: '  Butcher  shop ', ar: 'جزار' },
        description: ' Fresh meat ',
        categoryIds: [CATEGORY],
      },
      LOCALES,
    );

    expect(result).toEqual({
      ok: true,
      value: {
        names: [
          { locale: 'ar', name: 'جزار' },
          { locale: 'en', name: 'Butcher shop' },
        ],
        description: 'Fresh meat',
        categoryIds: [CATEGORY],
      },
    });
  });

  it('requires the name of the required locale; an empty one counts as missing', () => {
    for (const names of [{}, { ar: 'جزار' }, { en: '   ' }]) {
      const result = parseActivityContent({ names }, LOCALES);
      expect(result).toEqual({ ok: false, error: [{ path: 'names.en', code: 'required' }] });
    }
  });

  it('refuses unsupported locales, wrong types, long and hidden-character names', () => {
    const result = parseActivityContent(
      {
        names: { en: 'Grocery', de: 'Lebensmittel', ar: 7, fa: 'a'.repeat(81) },
      },
      LOCALES,
    );

    expect(result).toEqual({
      ok: false,
      error: [
        { path: 'names.ar', code: 'type' },
        { path: 'names.de', code: 'locale-unsupported' },
        { path: 'names.fa', code: 'too-long' },
      ],
    });
    expect(parseActivityContent({ names: { en: 'A​B' } }, LOCALES)).toEqual({
      ok: false,
      error: [{ path: 'names.en', code: 'chars' }],
    });
  });

  it('refuses the same name in two locales of one activity', () => {
    const result = parseActivityContent({ names: { en: 'Deli', ar: 'deli' } }, LOCALES);

    expect(result.ok).toBe(false);
  });

  it('judges the description and the category list', () => {
    const result = parseActivityContent(
      {
        names: { en: 'Grocery' },
        description: 'x'.repeat(301),
        categoryIds: [CATEGORY, CATEGORY, 'nope', 4],
      },
      LOCALES,
    );

    expect(result).toEqual({
      ok: false,
      error: [
        { path: 'description', code: 'too-long' },
        { path: 'categoryIds.1', code: 'duplicate' },
        { path: 'categoryIds.2', code: 'format' },
        { path: 'categoryIds.3', code: 'format' },
      ],
    });
  });

  it('treats an absent or blank description and an absent category list as empty', () => {
    expect(parseActivityContent({ names: { en: 'Grocery' }, description: '  ' }, LOCALES)).toEqual({
      ok: true,
      value: { names: [{ locale: 'en', name: 'Grocery' }], description: null, categoryIds: [] },
    });
  });
});

describe('activity codes', () => {
  it('derives a lower case ASCII code from a name', () => {
    expect(suggestActivityCode('Fresh & Frozen Café')).toBe('fresh-frozen-cafe');
    expect(suggestActivityCode('جزار')).toBe('activity');
    expect(suggestActivityCode('a'.repeat(60))).toHaveLength(40);
  });

  it('accepts only hyphen-joined lower case words', () => {
    expect(isActivityCode('butcher')).toBe(true);
    expect(isActivityCode('fresh-meat-2')).toBe(true);
    expect(isActivityCode('Butcher')).toBe(false);
    expect(isActivityCode('-x')).toBe(false);
    expect(isActivityCode('a'.repeat(41))).toBe(false);
    expect(isActivityCode(5)).toBe(false);
  });

  it('tidies inner whitespace', () => {
    expect(tidyActivityText('  a \n b  ')).toBe('a b');
  });
});
