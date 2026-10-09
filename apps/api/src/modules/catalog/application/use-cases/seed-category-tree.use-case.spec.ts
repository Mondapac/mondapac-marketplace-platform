import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import {
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
} from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { PlatformCategory } from '../../domain/platform-category';
import type { CategorySeed, SeededCategory } from '../ports/category-seed';
import type {
  CategoryTreeVersion,
  PlatformCategoryRepository,
} from '../ports/platform-category.repository';
import type { CheckClaimText, CheckedText } from '../claim-text/check-claim-text.service';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import { SeedCategoryTree } from './seed-category-tree.use-case';

/** A claim-text check whose verdict for a text is `found` when it contains "halal". */
function fakeCheck(options: { unavailable?: boolean } = {}) {
  const seen: CheckedText[][] = [];
  const check = {
    executeAsSystem: (_c: unknown, texts: readonly CheckedText[]) => {
      seen.push([...texts]);
      return Promise.resolve({
        ok: true as const,
        value: texts.map((item) => ({
          field: item.field,
          ref: item.ref,
          locale: item.locale,
          code: options.unavailable
            ? ('claim-text.check-unavailable' as const)
            : item.text.toLowerCase().includes('halal')
              ? ('claim-text.found' as const)
              : ('clean' as const),
          ...(options.unavailable || !item.text.toLowerCase().includes('halal')
            ? {}
            : { hits: [] }),
        })),
      });
    },
  } as unknown as CheckClaimText;
  return { check, seen };
}
const policy = {
  locales: () => ({ default: 'xx', supported: ['xx'] }),
} as unknown as CatalogMarketPolicy;

// The seed use case (catalog design 4.6, 7.2) in memory for both Market fixtures: system only,
// create-only, existing slugs skipped whatever their state, a seed that breaks a rule refused
// with the slug named. The SQL is covered by test/db/catalog-category-tree.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));

class MemoryCategories implements PlatformCategoryRepository {
  readonly bySlug = new Map<string, Id<'Category'>>();
  version = 1;
  treeVersion(): Promise<CategoryTreeVersion> {
    return Promise.resolve({ version: this.version });
  }
  bumpTreeVersion(_market: MarketContext, expected: number): Promise<void> {
    if (expected !== this.version) throw new Error('stale');
    this.version += 1;
    return Promise.resolve();
  }
  idBySlug(_market: MarketContext, slug: string): Promise<Id<'Category'> | null> {
    return Promise.resolve(this.bySlug.get(slug) ?? null);
  }
  add(_market: MarketContext, category: PlatformCategory): Promise<void> {
    this.bySlug.set(category.state.slug, category.state.id);
    return Promise.resolve();
  }
}

const entry = (
  slug: string,
  parentSlug: string | null = null,
  name = 'A name',
): SeededCategory => ({
  slug,
  parentSlug,
  verticalRootCode: null,
  names: [{ locale: 'xx', name }],
});

describe.each(TEST_MARKETS)('SeedCategoryTree in market %s', (code) => {
  const market = testMarketContext(code, 'default');

  function build(tree: readonly SeededCategory[], checkOptions: { unavailable?: boolean } = {}) {
    const { check, seen } = fakeCheck(checkOptions);
    let sequence = 0;
    const appended: unknown[] = [];
    const categories = new MemoryCategories();
    const unitOfWork = {
      run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
    } as unknown as UnitOfWork;
    const outbox = {
      append: (_context: unknown, events: readonly unknown[]) => {
        appended.push(...events);
        return Promise.resolve();
      },
    } as unknown as OutboxWriter;
    const seed: CategorySeed = { tree: () => tree };
    const useCase = new SeedCategoryTree(createUseCaseGate(markets, null), {
      unitOfWork,
      categories,
      seed,
      check,
      policy,
      outbox,
      clock: new FixedClock(Temporal.Instant.from('2026-10-08T00:00:00Z')),
      ids: {
        next: <T extends string>() =>
          `01990000-0000-7000-8000-${String(++sequence).padStart(12, '0')}` as Id<T>,
      },
    });
    return { useCase, categories, appended, seen };
  }

  const system = () => testCallContext(market, 'system', 'seed-category-tree-0001');

  it('declares rule system under its own name', () => {
    expect(SeedCategoryTree.access).toEqual({
      name: 'catalog.seed-category-tree',
      rule: { kind: 'system' },
    });
  });

  it('creates the tree once, parents first, one event each, and creates nothing on a rerun', async () => {
    const s = build([entry('garden'), entry('garden-tools', 'garden')]);

    await expect(s.useCase.execute(system(), {})).resolves.toEqual({
      ok: true,
      value: { created: 2 },
    });
    expect(s.appended).toHaveLength(2);
    expect(s.categories.version).toBe(3);

    await expect(s.useCase.execute(system(), {})).resolves.toEqual({
      ok: true,
      value: { created: 0 },
    });
    expect(s.appended).toHaveLength(2);
    expect(s.categories.version).toBe(3);
  });

  it('skips a slug that exists whatever its state: there is no update path', async () => {
    const s = build([entry('garden', null, 'New name')]);
    s.categories.bySlug.set('garden', '01990000-0000-7000-8000-0000000000ff' as Id<'Category'>);

    await expect(s.useCase.execute(system(), {})).resolves.toEqual({
      ok: true,
      value: { created: 0 },
    });
    expect(s.appended).toEqual([]);
    expect(s.categories.version).toBe(1);
  });

  it('answers an empty seed with created 0', async () => {
    const s = build([]);
    await expect(s.useCase.execute(system(), {})).resolves.toEqual({
      ok: true,
      value: { created: 0 },
    });
  });

  it('refuses a parent that is not in the tree, naming the slug', async () => {
    const s = build([entry('orphan', 'missing-parent')]);
    await expect(s.useCase.execute(system(), {})).resolves.toEqual({
      ok: false,
      error: { code: 'category.seed-invalid', slug: 'orphan', reason: 'parent-missing' },
    });
    expect(s.appended).toEqual([]);
  });

  it('refuses a seed that breaks a domain rule, naming the slug, and keeps the earlier ones', async () => {
    const s = build([entry('garden'), entry('Bad-Slug')]);
    const result = await s.useCase.execute(system(), {});
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'category.seed-invalid', slug: 'Bad-Slug' },
    });
    expect(s.categories.bySlug.has('garden')).toBe(true);
  });

  it('refuses every caller but the system', async () => {
    const s = build([entry('garden')]);
    const anonymous = testCallContext(market, 'anonymous', 'seed-category-tree-0002');
    const result = await s.useCase.execute(anonymous, {});
    expect(result.ok).toBe(false);
    expect(s.appended).toEqual([]);
    expect(s.categories.bySlug.size).toBe(0);
  });

  it('checks every slug and name as the system actor before writing anything', async () => {
    const s = build([entry('garden'), entry('tools', 'garden', 'Tools')]);
    await s.useCase.execute(system(), {});
    expect(s.seen).toHaveLength(1);
    expect(s.seen[0]).toEqual([
      { field: 'platform-category.slug', ref: 'garden', locale: 'xx', text: 'garden' },
      { field: 'platform-category.name', ref: 'garden', locale: 'xx', text: 'A name' },
      { field: 'platform-category.slug', ref: 'tools', locale: 'xx', text: 'tools' },
      { field: 'platform-category.name', ref: 'tools', locale: 'xx', text: 'Tools' },
    ]);
  });

  it('refuses the whole run, creating nothing, when a name holds a claim word', async () => {
    const s = build([entry('garden'), entry('meat', null, 'Halal meat')]);
    const result = await s.useCase.execute(system(), {});
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'seed.claim-text-refused',
        places: [{ field: 'platform-category.name', ref: 'meat' }],
      },
    });
    expect(s.categories.bySlug.size).toBe(0);
    expect(s.appended).toHaveLength(0);
  });

  it('refuses the whole run, creating nothing, when the check is unavailable', async () => {
    const s = build([entry('garden')], { unavailable: true });
    const result = await s.useCase.execute(system(), {});
    expect(!result.ok && result.error.code).toBe('seed.claim-text-unavailable');
    expect(s.categories.bySlug.size).toBe(0);
  });
});
