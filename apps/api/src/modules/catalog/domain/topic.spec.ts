import {
  isTopicSlug,
  normaliseTopicTerm,
  orderTerms,
  parseTopicContent,
  suggestTopicSlug,
  TOPIC_SYNONYMS_MAX,
  type TopicTerm,
} from './topic';

// The topic rules of package T1 in memory: the shared normaliser (English now, Persian and Arabic
// written and tested from the start), the slug, and the content parser on both Market fixtures'
// locale shapes.

describe('normaliseTopicTerm', () => {
  it('folds case, punctuation, symbols and spaces for English', () => {
    expect(normaliseTopicTerm('  BBQ ')).toBe('bbq');
    expect(normaliseTopicTerm('Barbecue & Grill!')).toBe('barbecue and grill');
    expect(normaliseTopicTerm('Mother’s   Day')).toBe('mother s day');
    expect(normaliseTopicTerm('Ｆｕｌｌ width')).toBe('full width');
  });

  it('folds the Arabic letter forms, diacritics, tatweel, ZWNJ and digits for Persian', () => {
    expect(normaliseTopicTerm('نوروز')).toBe(normaliseTopicTerm('نوروز'));
    expect(normaliseTopicTerm('غذاي ايراني')).toBe('غذای ایرانی');
    expect(normaliseTopicTerm('كباب')).toBe('کباب');
    expect(normaliseTopicTerm('آش')).toBe('اش');
    expect(normaliseTopicTerm('مُحَرَّم')).toBe('محرم');
    expect(normaliseTopicTerm('شیـــرینی')).toBe('شیرینی');
    expect(normaliseTopicTerm('شب‌یلدا')).toBe('شب یلدا');
    expect(normaliseTopicTerm('۱۴۰۵ و ١٤٠٥')).toBe('1405 و 1405');
  });

  it('gives the same key to the forms a person would call one word', () => {
    const forms = ['Ramadan', 'RAMADAN', ' ramadan. ', 'Ramadan!'];
    expect(new Set(forms.map(normaliseTopicTerm))).toEqual(new Set(['ramadan']));
  });
});

describe('topic slug', () => {
  it('suggests lower case ASCII words joined by hyphens', () => {
    expect(suggestTopicSlug('Persian Cuisine')).toBe('persian-cuisine');
    expect(suggestTopicSlug('Café & Brunch')).toBe('cafe-and-brunch');
    expect(suggestTopicSlug('نوروز')).toBe('topic');
    expect(suggestTopicSlug('x'.repeat(60))).toHaveLength(40);
  });

  it('accepts only the slug shape', () => {
    expect(isTopicSlug('ramadan')).toBe(true);
    expect(isTopicSlug('mothers-day-2')).toBe(true);
    expect(isTopicSlug('Ramadan')).toBe(false);
    expect(isTopicSlug('a--b')).toBe(false);
    expect(isTopicSlug('-a')).toBe(false);
    expect(isTopicSlug('a'.repeat(41))).toBe(false);
    expect(isTopicSlug(7)).toBe(false);
  });
});

describe.each([
  { market: 'AU', required: 'en', other: 'ar' },
  { market: 'ZZ', required: 'zz', other: 'en' },
])('parseTopicContent in market $market', ({ required, other }) => {
  const locales = { required, supported: [required, other] };

  it('keeps the name first, synonyms in order, by locale, with their keys', () => {
    const result = parseTopicContent(
      {
        group: 'cuisine',
        names: { [required]: ' Persian  food ', [other]: 'طعام فارسي' },
        synonyms: { [required]: ['Iranian food', 'Persian cuisine'] },
        intro: '  Rice, kebab and herbs.\r\n\r\n\r\nFor the whole family.  ',
      },
      locales,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.group).toBe('cuisine');
    expect(result.value.intro).toBe('Rice, kebab and herbs.\n\nFor the whole family.');
    const byLocale = (locale: string) =>
      result.value.terms.filter((t) => t.locale === locale).map((t) => [t.kind, t.text, t.key]);
    expect(byLocale(required)).toEqual([
      ['name', 'Persian food', 'persian food'],
      ['synonym', 'Iranian food', 'iranian food'],
      ['synonym', 'Persian cuisine', 'persian cuisine'],
    ]);
    expect(byLocale(other)).toEqual([['name', 'طعام فارسي', 'طعام فارسی']]);
  });

  it('judges every field and returns the problems together', () => {
    const result = parseTopicContent(
      {
        group: 'season',
        names: { [other]: 'x', xx: 'Name' },
        synonyms: { [required]: ['A synonym'], [other]: 'not a list' },
        intro: 7,
      },
      locales,
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect([...result.error].sort((a, b) => a.path.localeCompare(b.path))).toEqual(
      [
        { path: 'group', code: 'unknown' },
        { path: 'intro', code: 'type' },
        { path: `names.${other}`, code: 'too-short' },
        { path: `names.${required}`, code: 'required' },
        { path: 'names.xx', code: 'locale-unsupported' },
        { path: `synonyms.${other}`, code: 'type' },
        { path: `synonyms.${required}`, code: 'name-missing' },
      ].sort((a, b) => a.path.localeCompare(b.path)),
    );
  });

  it('refuses a missing group, links, hidden characters and long texts', () => {
    const result = parseTopicContent(
      {
        names: { [required]: 'Visit www.example.com' },
        synonyms: { [other]: [] },
        intro: 'x'.repeat(1001),
      },
      { required, supported: [required, other] },
    );
    const hidden = parseTopicContent(
      { group: 'use', names: { [required]: 'BB​Q' }, intro: 'See https://x.y' },
      locales,
    );
    const long = parseTopicContent(
      { group: 'use', names: { [required]: 'x'.repeat(41) } },
      locales,
    );

    expect(result.ok || result.error).toEqual([
      { path: 'group', code: 'required' },
      { path: `names.${required}`, code: 'link' },
      { path: 'intro', code: 'too-long' },
    ]);
    expect(hidden.ok || hidden.error).toEqual([
      { path: `names.${required}`, code: 'chars' },
      { path: 'intro', code: 'link' },
    ]);
    expect(long.ok || long.error).toEqual([{ path: `names.${required}`, code: 'too-long' }]);
  });

  it('allows the zero-width non-joiner Persian spelling needs', () => {
    const result = parseTopicContent(
      { group: 'occasion', names: { [required]: 'شب‌یلدا' } },
      locales,
    );

    expect(result.ok && result.value.terms[0]).toEqual({
      locale: required,
      kind: 'name',
      text: 'شب‌یلدا',
      key: 'شب یلدا',
    });
  });

  it('refuses a synonym that repeats the name or another synonym, and too many synonyms', () => {
    const repeats = parseTopicContent(
      {
        group: 'use',
        names: { [required]: 'BBQ' },
        synonyms: { [required]: ['bbq', 'Barbecue', 'BARBECUE', ''] },
      },
      locales,
    );
    const many = parseTopicContent(
      {
        group: 'use',
        names: { [required]: 'BBQ' },
        synonyms: {
          [required]: Array.from({ length: TOPIC_SYNONYMS_MAX + 1 }, (_, i) => `Grill ${i}`),
        },
      },
      locales,
    );

    expect(repeats.ok || repeats.error).toEqual([
      { path: `synonyms.${required}.0`, code: 'duplicate' },
      { path: `synonyms.${required}.2`, code: 'duplicate' },
    ]);
    expect(many.ok || many.error).toEqual([{ path: `synonyms.${required}`, code: 'too-many' }]);
  });
});

describe('orderTerms', () => {
  it('sorts by locale, the name first, and keeps the given synonym order', () => {
    const term = (locale: string, kind: TopicTerm['kind'], text: string): TopicTerm => ({
      locale,
      kind,
      text,
      key: text,
    });

    expect(
      orderTerms([
        term('en', 'synonym', 'b'),
        term('ar', 'name', 'n'),
        term('en', 'synonym', 'a'),
        term('en', 'name', 'm'),
      ]).map((t) => `${t.locale}:${t.text}`),
    ).toEqual(['ar:n', 'en:m', 'en:b', 'en:a']);
  });
});
