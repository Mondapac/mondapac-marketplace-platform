import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_SELLER_FILTERS } from '../src/sellers/sellers-state.ts';
import type { ApiRead } from '../src/storefront/api.ts';
import { loadSeller, loadSellers } from '../src/storefront/source.ts';

// The seller reads in source.ts with the API configured: which route they read, how a missing
// store differs from a fault, and the sellers page's paging and filters.

const reads = vi.hoisted(() => ({ answers: [] as ApiRead<unknown>[], paths: [] as string[] }));

vi.mock('../src/storefront/api.ts', () => ({
  apiGet: (path: string) => {
    reads.paths.push(path);
    return Promise.resolve(reads.answers.shift() ?? { kind: 'failed' });
  },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: () =>
    Promise.resolve(Object.assign((code: string) => `name of ${code}`, { has: () => true })),
}));

const store = (slug: string) => ({
  slug,
  name: `Store ${slug}`,
  serviceAreaCode: 'greater-brisbane',
  sellingSince: 2026,
  minimumOrder: null,
});

beforeEach(() => {
  reads.answers = [];
  reads.paths = [];
});

describe('seller page read', () => {
  it('reads the store by its slug', async () => {
    reads.answers = [{ kind: 'ok', body: store('kedron') }];
    const shop = await loadSeller('kedron');
    expect(reads.paths).toEqual(['sellers/stores/kedron']);
    expect(shop?.name).toBe('Store kedron');
    expect(shop?.location).toBe('name of greater-brisbane');
  });

  it("answers no store for the module's not-found and a malformed slug, without a read", async () => {
    reads.answers = [{ kind: 'failed', status: 404, code: 'sellers.store-not-found' }];
    expect(await loadSeller('gone')).toBeUndefined();
    expect(await loadSeller('../admin')).toBeUndefined();
    expect(await loadSeller('a'.repeat(51))).toBeUndefined();
    expect(reads.paths).toEqual(['sellers/stores/gone']);
  });

  it('throws on any other failure, a bare 404 included, so the page shows its error', async () => {
    reads.answers = [{ kind: 'failed', status: 404 }];
    await expect(loadSeller('kedron')).rejects.toThrow('the store read failed');
    reads.answers = [{ kind: 'failed', status: 503 }];
    await expect(loadSeller('kedron')).rejects.toThrow('the store read failed');
    reads.answers = [{ kind: 'failed' }];
    await expect(loadSeller('kedron')).rejects.toThrow('the store read failed');
  });

  it('keeps the sample while the API is off', async () => {
    reads.answers = [{ kind: 'off' }];
    expect((await loadSeller('kedron'))?.name).toBe('Kedron Halal Butchers');
  });
});

describe('sellers page read', () => {
  const page = (from: number, count: number, total: number) => ({
    kind: 'ok' as const,
    body: { items: Array.from({ length: count }, (_, i) => store(`s-${from + i}`)), total },
  });

  it('reads pages of 48 until the limit, with the sort the API knows', async () => {
    reads.answers = [page(0, 48, 60), page(48, 12, 60)];
    const results = await loadSellers({ filters: NO_SELLER_FILTERS, sort: 'popular', limit: 50 });
    expect(reads.paths).toEqual([
      'sellers/stores?sort=name&page=1&pageSize=48',
      'sellers/stores?sort=name&page=2&pageSize=48',
    ]);
    expect(results.items).toHaveLength(50);
    expect(results.total).toBe(60);
    expect(results.filtersOffered).toBe(false);
  });

  it('matches nothing for a filter it cannot answer, reading only the count', async () => {
    reads.answers = [page(0, 1, 3)];
    const results = await loadSellers({
      filters: { ...NO_SELLER_FILTERS, sameDay: true },
      sort: 'newest',
      limit: 24,
    });
    expect(reads.paths).toEqual(['sellers/stores?pageSize=1']);
    expect(results.items).toEqual([]);
    expect(results.total).toBe(0);
    expect(results.all).toBe(3);
  });

  it('reads at most four pages for one view, however far Show more went', async () => {
    reads.answers = [0, 1, 2, 3, 4].map((n) => page(n * 48, 48, 1000));
    const results = await loadSellers({ filters: NO_SELLER_FILTERS, sort: 'name', limit: 1200 });
    expect(reads.paths).toHaveLength(4);
    expect(results.items).toHaveLength(192);
  });

  it('throws on a failed read and keeps the sample while the API is off', async () => {
    reads.answers = [{ kind: 'failed', status: 503 }];
    await expect(
      loadSellers({ filters: NO_SELLER_FILTERS, sort: 'name', limit: 24 }),
    ).rejects.toThrow('the store read failed');
    reads.answers = [{ kind: 'off' }];
    const sample = await loadSellers({ filters: NO_SELLER_FILTERS, sort: 'name', limit: 24 });
    expect(sample.total).toBe(18);
  });
});
