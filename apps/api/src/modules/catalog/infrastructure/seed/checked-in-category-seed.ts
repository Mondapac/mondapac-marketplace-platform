import type { MarketContext } from '@mondapac/shared-kernel';
import type { CategorySeed, SeededCategory } from '../../application/ports/category-seed';
import { ZZ_CATEGORY_TREE } from './zz.category-tree.seed';

/** A seed that breaks a rule of catalog design 7.2: refused at boot and by the unit test. */
export class CategorySeedError extends Error {}

/** The checked-in seeds, by Market id. A Market with none has an empty tree until slice 21. */
const SEEDS: Readonly<Record<string, readonly SeededCategory[]>> = { ZZ: ZZ_CATEGORY_TREE };

/**
 * Checks one seed file: a slug appears once, and a parent is listed before the child that names
 * it (so a run creates parents first and a parent is never invented).
 */
export function assertCategorySeed(tree: readonly SeededCategory[]): void {
  const seen = new Set<string>();
  for (const entry of tree) {
    if (seen.has(entry.slug)) {
      throw new CategorySeedError(`Seed slug "${entry.slug}" is listed twice`);
    }
    if (entry.parentSlug !== null && !seen.has(entry.parentSlug)) {
      throw new CategorySeedError(
        `Seed parent "${entry.parentSlug}" is not listed before "${entry.slug}"`,
      );
    }
    seen.add(entry.slug);
  }
}

export class CheckedInCategorySeed implements CategorySeed {
  constructor(seeds: Readonly<Record<string, readonly SeededCategory[]>> = SEEDS) {
    this.#seeds = seeds;
    for (const tree of Object.values(seeds)) assertCategorySeed(tree);
  }

  readonly #seeds: Readonly<Record<string, readonly SeededCategory[]>>;

  tree(market: MarketContext): readonly SeededCategory[] {
    return this.#seeds[market.marketId] ?? [];
  }
}
