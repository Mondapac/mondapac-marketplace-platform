import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// SEO package 5 follow-up. A `loading.tsx` flushes the page shell with HTTP 200 before the page has
// read anything, so a route that can answer 404 or a redirect must not sit under one; every other
// route that reads data must have one, or its page stays blank until the whole read is done.
const app = (path: string) => new URL(`../app/${path}`, import.meta.url);

describe('loading boundaries', () => {
  it.each([
    '(home)/loading.tsx',
    'cart/loading.tsx',
    'checkout/loading.tsx',
    'account/(member)/(pages)/loading.tsx',
    'account/personalization/loading.tsx',
    'c/loading.tsx',
    'search/loading.tsx',
    'brands/loading.tsx',
    'sellers/loading.tsx',
  ])('has %s', (path) => {
    expect(existsSync(app(path))).toBe(true);
  });

  it('puts the home page, the cart, checkout and the account pages under one', () => {
    expect(existsSync(app('(home)/page.tsx'))).toBe(true);
    expect(existsSync(app('page.tsx'))).toBe(false);
    for (const page of ['addresses', 'delete', 'lists', 'reviews', 'settings', 'orders']) {
      expect(existsSync(app(`account/(member)/(pages)/${page}/page.tsx`))).toBe(true);
    }
  });

  it('keeps every route that answers 404 or a redirect from its page free of one', () => {
    // No loading.tsx here or above: not at the root, not in the routes themselves.
    for (const path of [
      'loading.tsx',
      'p/loading.tsx',
      'p/[id]/loading.tsx',
      's/loading.tsx',
      's/[slug]/loading.tsx',
      'account/loading.tsx',
      'account/(member)/loading.tsx',
      'account/(member)/orders/loading.tsx',
      'account/(member)/orders/[id]/loading.tsx',
    ]) {
      expect(existsSync(app(path)), path).toBe(false);
    }
    expect(existsSync(app('account/(member)/orders/[id]/page.tsx'))).toBe(true);
  });
});
