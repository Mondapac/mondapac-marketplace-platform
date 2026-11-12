import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../app/api/search-suggest/route.ts';
import * as source from '../src/storefront/source.ts';

vi.mock('../src/storefront/source.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof source>();
  return { ...actual, loadSuggestions: vi.fn(actual.loadSuggestions) };
});

const load = vi.mocked(source.loadSuggestions);
const call = (q: string) =>
  GET(new Request(`http://shop.test/api/search-suggest?q=${encodeURIComponent(q)}`));

const ANSWER = { products: [], stores: [], total: 0, totalIsCapped: false };

beforeEach(() => {
  load.mockClear();
});

describe('GET /api/search-suggest', () => {
  it('refuses under two characters with 400, no-store, and reads nothing', async () => {
    for (const q of ['', ' a ', 'a']) {
      const response = await call(q);
      expect(response.status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(load).not.toHaveBeenCalled();
  });

  it('cuts the text to 100 characters and answers no-store', async () => {
    load.mockResolvedValueOnce({ kind: 'ok', answer: ANSWER });
    const response = await call('x'.repeat(101));
    expect(load).toHaveBeenCalledWith('x'.repeat(100));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual(ANSWER);
  });

  it('answers 502 with no error text when the read failed', async () => {
    load.mockResolvedValueOnce({ kind: 'failed', status: 503 });
    const response = await call('bak');
    expect(response.status).toBe(502);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ code: 'search.unavailable' });
  });

  it('passes a 429 on as 429', async () => {
    load.mockResolvedValueOnce({ kind: 'failed', status: 429 });
    const response = await call('bak');
    expect(response.status).toBe(429);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('answers from the sample catalog while the API is off', async () => {
    const response = await call('lamb');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { products: { name: string }[]; total: number };
    expect(body.products[0]?.name).toMatch(/^Lamb/u);
    expect(body.total).toBeGreaterThan(0);
  });
});
