import { describe, expect, it } from 'vitest';
import type { ApiRead } from '../src/storefront/api.ts';
import { categoryRedirect } from '../src/storefront/category-redirect.ts';

// The proxy's category redirects (categories C6): exactly 301 or 302, one hop, and a target that is
// always `/c/<slug>` built here from a checked slug, never a URL from the answer.

type Answers = Record<string, ApiRead<unknown>>;
const notFound: ApiRead<unknown> = {
  kind: 'failed',
  status: 404,
  code: 'catalog.category-not-found',
};
const category = (slug: string): ApiRead<unknown> => ({
  kind: 'ok',
  body: { kind: 'category', id: 'x', slug },
});
const moved = (slug: string, permanent: boolean): ApiRead<unknown> => ({
  kind: 'ok',
  body: { kind: 'redirect', slug, permanent },
});

function reader(answers: Answers) {
  const asked: string[] = [];
  const read = (slug: string) => {
    asked.push(slug);
    return Promise.resolve(answers[slug] ?? notFound);
  };
  return { asked, read };
}

describe('category redirects', () => {
  it('lets a live category, an unknown slug and an API that did not answer reach the page', async () => {
    const { read } = reader({ meat: category('meat'), down: { kind: 'failed', status: 503 } });

    expect(await categoryRedirect('/c/meat', '', read)).toBeNull();
    expect(await categoryRedirect('/c/nope', '', read)).toBeNull();
    expect(await categoryRedirect('/c/down', '', read)).toBeNull();
    expect(
      await categoryRedirect('/c/meat', '', () => Promise.resolve({ kind: 'off' })),
    ).toBeNull();
  });

  it('answers a moved slug with one 301 and a hidden one with a 302, keeping the query', async () => {
    const { read } = reader({
      'old-meat': moved('halal-meat', true),
      secret: moved('pantry', false),
    });

    expect(await categoryRedirect('/c/old-meat', '?page=2', read)).toEqual({
      location: '/c/halal-meat?page=2',
      status: 301,
    });
    expect(await categoryRedirect('/c/secret', '', read)).toEqual({
      location: '/c/pantry',
      status: 302,
    });
  });

  it('moves the old two-level address: the subcategory first, then the category', async () => {
    const { read, asked } = reader({
      lamb: category('lamb'),
      meat: category('meat'),
      'old-sub': moved('goat', true),
      hidden: moved('pantry', false),
    });

    expect(await categoryRedirect('/c/meat/lamb', '?sort=x', read)).toEqual({
      location: '/c/lamb?sort=x',
      status: 301,
    });
    expect(await categoryRedirect('/c/meat/old-sub', '', read)).toEqual({
      location: '/c/goat',
      status: 301,
    });
    expect(await categoryRedirect('/c/meat/hidden', '', read)).toEqual({
      location: '/c/pantry',
      status: 302,
    });
    expect(await categoryRedirect('/c/meat/gone', '', read)).toEqual({
      location: '/c/meat',
      status: 301,
    });
    expect(await categoryRedirect('/c/gone/also-gone', '', read)).toBeNull();
    // The first old path was answered by its subcategory alone.
    expect(asked[0]).toBe('lamb');
    expect(asked[1]).toBe('old-sub');
  });

  it.each([
    '/c/%2F%2Fevil.com',
    '/c/%5C%5Cevil.com',
    '/c/https%3A%2F%2Fevil.com',
    '/c/Meat',
    '/c/meat/lamb/chops',
    '/c/%E0%A4%A',
    '/c/meat/%2F%2Fevil.com',
  ])('never asks the API or redirects for %s unless a segment is a slug', async (path) => {
    const { read, asked } = reader({ meat: category('meat') });

    const answer = await categoryRedirect(path, '', read);

    expect(answer === null || answer.location === '/c/meat').toBe(true);
    expect(asked.every((slug) => /^[a-z0-9]+(-[a-z0-9]+)*$/u.test(slug))).toBe(true);
  });

  it.each([
    { kind: 'redirect', slug: '//evil.com', permanent: true },
    { kind: 'redirect', slug: 'https://evil.com', permanent: true },
    { kind: 'redirect', slug: '\\\\evil.com', permanent: false },
    { kind: 'redirect', slug: 'old-meat', permanent: true },
    { kind: 'redirect', slug: 'halal-meat' },
    { kind: 'redirect', location: '//evil.com' },
  ])('ignores an answer whose target is not a slug, or points back: %j', async (body) => {
    const read = () => Promise.resolve({ kind: 'ok', body } as ApiRead<unknown>);

    expect(await categoryRedirect('/c/old-meat', '', read)).toBeNull();
  });
});
