import { testMarketContext } from '@mondapac/shared-kernel/testing';
import { PlatformCategory } from '../../domain/platform-category';
import {
  CategorySeedError,
  CheckedInCategorySeed,
  assertCategorySeed,
} from './checked-in-category-seed';
import { ZZ_CATEGORY_TREE } from './zz.category-tree.seed';
import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId } from '@mondapac/shared-kernel';

describe('the checked-in category seed', () => {
  it('gives the fixture Market its tree and every other Market an empty one', () => {
    const seed = new CheckedInCategorySeed();
    expect(seed.tree(testMarketContext('ZZ', 'default'))).toBe(ZZ_CATEGORY_TREE);
    expect(seed.tree(testMarketContext('AU', 'default'))).toEqual([]);
  });

  it('lists every parent before its children and every slug once', () => {
    expect(() => assertCategorySeed(ZZ_CATEGORY_TREE)).not.toThrow();
  });

  it('refuses a repeated slug and a parent listed later', () => {
    const entry = { slug: 'a1', parentSlug: null, verticalRootCode: null, names: [] };
    expect(() => assertCategorySeed([entry, entry])).toThrow(CategorySeedError);
    expect(() => assertCategorySeed([{ ...entry, slug: 'b1', parentSlug: 'a1' }, entry])).toThrow(
      CategorySeedError,
    );
  });

  it('every category of the fixture tree is a valid PlatformCategory', () => {
    const now = Temporal.Instant.from('2026-10-08T00:00:00Z');
    for (const entry of ZZ_CATEGORY_TREE) {
      const result = PlatformCategory.create({
        id: entry.slug as Id<'Category'>,
        revisionId: entry.slug as Id<'CategoryRevision'>,
        marketId: 'ZZ' as MarketId,
        parentId: entry.parentSlug as Id<'Category'> | null,
        verticalRootCode: entry.verticalRootCode,
        slug: entry.slug,
        names: entry.names,
        createdByKind: 'seed',
        now,
      });
      expect(result.ok ? null : result.error.code).toBeNull();
    }
  });
});
