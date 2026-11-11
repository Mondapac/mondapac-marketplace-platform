import type { MarketContext } from '@mondapac/shared-kernel';
import type { CultureSeed, SeededCulture } from '../../application/ports/culture-seed';
import { loadFileCatalogSeeds } from './file-catalog-seed';
import { ZZ_CULTURES } from './zz.cultures.seed';

/** A seed that breaks a rule of the culture model: refused at boot and by the unit test. */
export class CultureSeedError extends Error {}

const defaultSeeds = (): Readonly<Record<string, readonly SeededCulture[]>> => ({
  ...loadFileCatalogSeeds().cultures,
  ZZ: ZZ_CULTURES,
});

/** Checks one Market's seed: codes are unique and at most one culture is the default. */
export function assertCultureSeed(list: readonly SeededCulture[]): void {
  const seen = new Set<string>();
  for (const entry of list) {
    if (seen.has(entry.code))
      throw new CultureSeedError(`Seed culture "${entry.code}" is listed twice`);
    seen.add(entry.code);
  }
  if (list.filter((entry) => entry.isDefault).length > 1) {
    throw new CultureSeedError('More than one seeded culture is the default');
  }
}

/** The checked-in cultures by Market id: the fixture Market in code, others from `config/catalog-seed`. */
export class CheckedInCultureSeed implements CultureSeed {
  constructor(seeds: Readonly<Record<string, readonly SeededCulture[]>> = defaultSeeds()) {
    this.#seeds = seeds;
    for (const list of Object.values(seeds)) assertCultureSeed(list);
  }

  readonly #seeds: Readonly<Record<string, readonly SeededCulture[]>>;

  cultures(market: MarketContext): readonly SeededCulture[] {
    return this.#seeds[market.marketId] ?? [];
  }
}
