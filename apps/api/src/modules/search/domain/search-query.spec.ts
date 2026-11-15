import { MAX_OR_TERMS, orTermsOf, parseSearchQuery } from './search-query';

describe('parseSearchQuery: the OR cap (Hassan L-3)', () => {
  const chain = (terms: number): string =>
    Array.from({ length: terms }, (_, n) => `t${n}`).join(' or ');

  it('counts the terms joined by or, in any case', () => {
    expect(orTermsOf('beef')).toBe(1);
    expect(orTermsOf('beef or lamb OR goat Or mince')).toBe(4);
    // a word that only contains "or" is a term, not a separator
    expect(orTermsOf('organic oregano')).toBe(1);
  });

  it('accepts a chain of at most the cap', () => {
    expect(parseSearchQuery({ q: chain(MAX_OR_TERMS) }).ok).toBe(true);
  });

  it('refuses a longer chain with a field error', () => {
    const result = parseSearchQuery({ q: chain(MAX_OR_TERMS + 1) });
    expect(result).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'q', code: 'too-many-terms' }] },
    });
  });
});
