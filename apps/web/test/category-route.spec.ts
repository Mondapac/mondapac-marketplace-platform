import { describe, expect, it, vi } from 'vitest';
import { generateMetadata } from '../app/c/[category]/[[...sub]]/page.tsx';

// The category route's path rules: a known category and subcategory resolve, anything deeper or
// a subcategory of another category is the 404 page. Sample data (API off), as with the API the
// same rules run on the live tree (shell-source.spec.ts, findInTree).

vi.mock('next-intl/server', () => ({
  getTranslations: () => Promise.resolve((key: string) => key),
}));

const metadata = (category: string, sub?: string[]) =>
  generateMetadata({
    params: Promise.resolve({ category, ...(sub ? { sub } : {}) }),
    searchParams: Promise.resolve({}),
  });

const NOT_FOUND = /NEXT_HTTP_ERROR_FALLBACK;404/u;
const digestOf = (error: unknown) => (error as { digest?: string }).digest ?? '';

describe('category route', () => {
  it('resolves a category and its subcategory', async () => {
    expect((await metadata('meat')).title).toBe('Meat | title');
    expect((await metadata('meat', ['lamb'])).title).toBe('Lamb | title');
  });

  it('is a 404 for a path deeper than one subcategory', async () => {
    const error: unknown = await metadata('meat', ['lamb', 'chops']).catch((e: unknown) => e);
    expect(digestOf(error)).toMatch(NOT_FOUND);
  });

  it('is a 404 for a subcategory of another category or an unknown category', async () => {
    for (const [category, sub] of [
      ['bakery', ['lamb']],
      ['nope', undefined],
    ] as const) {
      const error: unknown = await metadata(category, sub ? [...sub] : undefined).catch(
        (e: unknown) => e,
      );
      expect(digestOf(error)).toMatch(NOT_FOUND);
    }
  });
});
