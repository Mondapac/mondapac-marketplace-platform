import { isValidSlug, parsePostSlug, slugFromTitle, slugWithSuffix } from './slug';

describe('post slug', () => {
  it('accepts lower-case words joined by hyphens', () => {
    expect(isValidSlug('ramadan-table')).toBe(true);
    expect(isValidSlug('a1b')).toBe(true);
  });

  it.each([
    'ab',
    'Ramadan',
    'two--hyphens',
    '-lead',
    'trail-',
    'with space',
    'category',
    'events',
    'x'.repeat(81),
  ])('refuses %s', (value) => {
    expect(isValidSlug(value)).toBe(false);
  });

  it('reports why a typed slug is refused', () => {
    const problems: { path: string; code: string }[] = [];
    expect(parsePostSlug(problems, 'slug', 'Bad Slug')).toBeNull();
    expect(parsePostSlug(problems, 'slug', 'ab')).toBeNull();
    expect(parsePostSlug(problems, 'slug', undefined)).toBeNull();
    expect(problems).toEqual([
      { path: 'slug', code: 'format' },
      { path: 'slug', code: 'length' },
      { path: 'slug', code: 'required' },
    ]);
    expect(parsePostSlug([], 'slug', ' ok-slug ')).toBe('ok-slug');
  });

  it('makes a slug from a title, folding accents', () => {
    expect(slugFromTitle('Ramadan: a table for 8!')).toBe('ramadan-a-table-for-8');
    expect(slugFromTitle('Crème brûlée')).toBe('creme-brulee');
    expect(slugFromTitle('!!!')).toBe('');
    expect(slugFromTitle('Events')).toBe('');
    expect(slugFromTitle('word '.repeat(40)).length).toBeLessThanOrEqual(80);
  });

  it('adds a numeric suffix inside the length limit', () => {
    expect(slugWithSuffix('table', 2)).toBe('table-2');
    expect(slugWithSuffix('x'.repeat(80), 12)).toHaveLength(80);
  });
});
