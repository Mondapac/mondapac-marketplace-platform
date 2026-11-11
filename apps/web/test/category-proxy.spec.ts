import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiRead } from '../src/storefront/api.ts';

// The proxy's side of the category redirects (categories C6): the exact 301 or 302 with a
// site-relative Location, the query carried, the noindex header on the redirect, one resolve read
// per one-segment request, and the page left to answer when the resolver does not.

const answers = new Map<string, ApiRead<unknown>>();
const asked: string[] = [];

vi.mock('../src/storefront/api.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  apiGetWith: (_config: unknown, _headers: unknown, path: string) => {
    asked.push(path);
    const slug = new URLSearchParams(path.split('?')[1]).get('slug') ?? '';
    return Promise.resolve(answers.get(slug) ?? { kind: 'off' });
  },
}));

const { proxy } = await import('../proxy.ts');

const request = (path: string) => new NextRequest(`http://shop.example${path}`);
const ok = (body: unknown): ApiRead<unknown> => ({ kind: 'ok', body });

beforeEach(() => {
  answers.clear();
  asked.length = 0;
});

describe('category redirects in the proxy', () => {
  it('answers a retired slug with one 301 to where the chain ends, query kept, one read', async () => {
    // The API collapses A -> B -> C (and merged into merged) into one answer: the web makes one hop.
    answers.set('old-lamb', ok({ kind: 'redirect', slug: 'lamb', permanent: true }));

    const response = await proxy(request('/c/old-lamb?page=2&sort=price'));

    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('/c/lamb?page=2&sort=price');
    expect(response.headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
    expect(asked).toEqual(['catalog/categories/resolve?slug=old-lamb']);
  });

  it('answers a hidden category with 302', async () => {
    answers.set('lamb-chops', ok({ kind: 'redirect', slug: 'lamb', permanent: false }));

    const response = await proxy(request('/c/lamb-chops'));

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/c/lamb');
  });

  it('answers the old two-level address with 301 to the subcategory, query kept', async () => {
    answers.set('lamb', ok({ kind: 'category', id: 'x', slug: 'lamb' }));

    const response = await proxy(request('/c/meat/lamb?page=3'));

    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('/c/lamb?page=3');
    expect(asked).toEqual(['catalog/categories/resolve?slug=lamb']);
  });

  it('never redirects back to the asked slug, so a two-slug loop cannot bounce', async () => {
    // A -> B and B -> A: each request makes one read and B never redirects to itself.
    answers.set('a-cat', ok({ kind: 'redirect', slug: 'b-cat', permanent: true }));
    answers.set('b-cat', ok({ kind: 'redirect', slug: 'b-cat', permanent: true }));

    const first = await proxy(request('/c/a-cat'));
    const second = await proxy(request('/c/b-cat'));

    expect(first.headers.get('location')).toBe('/c/b-cat');
    expect(second.status).not.toBe(301);
    expect(second.headers.get('location')).toBeNull();
    expect(asked).toHaveLength(2);
  });

  it('lets the page answer a live category, an outage and a non-slug, with no Location', async () => {
    answers.set('meat', ok({ kind: 'category', id: 'x', slug: 'meat' }));
    answers.set('lamb', { kind: 'failed', status: 503 });

    for (const path of ['/c/meat', '/c/lamb', '/c/%2F%2Fevil.com', '/c/%5Cevil.com']) {
      const response = await proxy(request(path));
      expect(response.headers.get('location')).toBeNull();
      expect([301, 302, 307, 308]).not.toContain(response.status);
    }
    expect(asked).toEqual([
      'catalog/categories/resolve?slug=meat',
      'catalog/categories/resolve?slug=lamb',
    ]);
  });

  it('does not read the resolver outside /c/', async () => {
    await proxy(request('/p/0b5e1c3a-0000-4000-8000-0000000000c1'));
    // The product path makes its own existence read (test/miss.spec.ts), never the resolver's.
    expect(asked.filter((path) => path.startsWith('catalog/categories/resolve'))).toEqual([]);
  });
});
