import { describe, expect, it, vi } from 'vitest';
import { generateMetadata } from '../app/c/[slug]/page.tsx';
import OldCategoryPath from '../app/c/[slug]/[sub]/page.tsx';

// The category route's path rules (categories C6): one segment names a category at any depth, an
// unknown one is the 404 page. The old two-level address checks the subcategory first, then the
// category, and moves permanently; with the API on the proxy answers it first with a 301
// (category-redirect.spec.ts). Sample data here (API off).

vi.mock('next-intl/server', () => ({
  getTranslations: () => Promise.resolve((key: string) => key),
}));

const metadata = (slug: string) =>
  generateMetadata({
    params: Promise.resolve({ slug }),
    searchParams: Promise.resolve({}),
  });

const NOT_FOUND = /NEXT_HTTP_ERROR_FALLBACK;404/u;
const digestOf = (error: unknown) => (error as { digest?: string }).digest ?? '';
const old = (slug: string, sub: string) =>
  OldCategoryPath({ params: Promise.resolve({ slug, sub }) }).catch((e: unknown) => e);

describe('category route', () => {
  it('resolves a category and a subcategory by their own slug', async () => {
    expect((await metadata('meat')).title).toEqual({ absolute: 'Meat | title' });
    expect((await metadata('lamb')).title).toEqual({ absolute: 'Lamb | title' });
  });

  it('is a 404 for an unknown slug', async () => {
    const error: unknown = await metadata('nope').catch((e: unknown) => e);
    expect(digestOf(error)).toMatch(NOT_FOUND);
  });

  it('moves the old two-level address to the subcategory first, then the category', async () => {
    expect(digestOf(await old('meat', 'lamb'))).toBe('NEXT_REDIRECT;replace;/c/lamb;308;');
    // The subcategory is found whatever category the old path named.
    expect(digestOf(await old('bakery', 'lamb'))).toBe('NEXT_REDIRECT;replace;/c/lamb;308;');
    expect(digestOf(await old('meat', 'nope'))).toBe('NEXT_REDIRECT;replace;/c/meat;308;');
  });

  it('is a 404 for an old path that names nothing, or a segment that is not a slug', async () => {
    expect(digestOf(await old('nope', 'gone'))).toMatch(NOT_FOUND);
    expect(digestOf(await old('%2F%2Fevil.com', '..'))).toMatch(NOT_FOUND);
  });
});
