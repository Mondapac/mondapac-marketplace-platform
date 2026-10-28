import { parseCategory, parseTag } from './taxonomy';

const market = { defaultLocale: 'en-AU', supportedLocales: ['en-AU', 'ms-MY'] };

describe('categories', () => {
  it('needs the default locale name and refuses a locale the Market does not support', () => {
    const ok = parseCategory(
      { slug: 'recipes', names: { 'en-AU': 'Recipes' }, position: 3 },
      market,
      { slug: 'required' },
    );
    expect(ok.category).toEqual({
      slug: 'recipes',
      names: new Map([['en-AU', 'Recipes']]),
      position: 3,
    });
    expect(
      parseCategory({ slug: 'recipes', names: { 'ms-MY': 'Resipi' } }, market, { slug: 'required' })
        .problems,
    ).toEqual([{ path: 'names.en-AU', code: 'required' }]);
    expect(
      parseCategory({ slug: 'recipes', names: { 'en-AU': 'R', 'fr-FR': 'R' } }, market, {
        slug: 'required',
      }).problems,
    ).toEqual([{ path: 'names.fr-FR', code: 'locale' }]);
  });

  it('refuses a bad slug, markup in a name, and a slug on update', () => {
    expect(
      parseCategory({ slug: 'Bad', names: { 'en-AU': 'x' } }, market, { slug: 'required' })
        .problems,
    ).toEqual([{ path: 'slug', code: 'format' }]);
    expect(
      parseCategory({ slug: 'ok', names: { 'en-AU': '<b>' } }, market, { slug: 'required' })
        .problems,
    ).toEqual([{ path: 'names.en-AU', code: 'markup' }]);
    expect(
      parseCategory({ slug: 'ok', names: { 'en-AU': 'x' } }, market, { slug: 'forbidden' })
        .problems,
    ).toEqual([{ path: 'slug', code: 'unknown-field' }]);
  });
});

describe('tags', () => {
  it('makes the slug from the name when none is given', () => {
    expect(parseTag({ name: 'Slow Cooker' }).tag).toEqual({
      name: 'Slow Cooker',
      slug: 'slow-cooker',
    });
    expect(parseTag({ name: 'Eid', slug: 'eid-2026' }).tag).toEqual({
      name: 'Eid',
      slug: 'eid-2026',
    });
  });

  it('refuses a name with no usable slug and markup', () => {
    expect(parseTag({ name: '!!' }).problems).toEqual([{ path: 'slug', code: 'required' }]);
    expect(parseTag({ name: '<i>' }).problems).toEqual([{ path: 'name', code: 'markup' }]);
  });
});
