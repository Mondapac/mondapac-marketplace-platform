import type { MarketContext } from '@mondapac/shared-kernel';
import type {
  AttributeSeed,
  SeededDefinition,
  SeededFamily,
} from '../../application/ports/attribute-seed';
import { ZZ_ATTRIBUTE_DEFINITIONS, ZZ_ATTRIBUTE_FAMILIES } from './zz.attributes.seed';

/** A seed that breaks a rule of catalog design 7.2: refused at boot and by the unit test. */
export class AttributeSeedError extends Error {}

interface MarketAttributeSeed {
  readonly definitions: readonly SeededDefinition[];
  readonly families: readonly SeededFamily[];
}

/** The checked-in seeds, by Market id. A Market with none has no attributes until slice 21. */
const SEEDS: Readonly<Record<string, MarketAttributeSeed>> = {
  ZZ: { definitions: ZZ_ATTRIBUTE_DEFINITIONS, families: ZZ_ATTRIBUTE_FAMILIES },
};

/**
 * Checks one Market's seed: a definition code appears once, a family code appears once, and
 * every attribute a family names is a definition of the same seed.
 */
export function assertAttributeSeed(seed: MarketAttributeSeed): void {
  const codes = new Set<string>();
  for (const definition of seed.definitions) {
    if (codes.has(definition.code)) {
      throw new AttributeSeedError(`Seed definition "${definition.code}" is listed twice`);
    }
    codes.add(definition.code);
  }
  const families = new Set<string>();
  for (const family of seed.families) {
    if (families.has(family.code)) {
      throw new AttributeSeedError(`Seed family "${family.code}" is listed twice`);
    }
    families.add(family.code);
    for (const group of family.groups) {
      for (const entry of group.attributes) {
        if (!codes.has(entry.code)) {
          throw new AttributeSeedError(
            `Seed family "${family.code}" names "${entry.code}", which is not a seeded definition`,
          );
        }
      }
    }
  }
}

export class CheckedInAttributeSeed implements AttributeSeed {
  readonly #seeds: Readonly<Record<string, MarketAttributeSeed>>;

  constructor(seeds: Readonly<Record<string, MarketAttributeSeed>> = SEEDS) {
    this.#seeds = seeds;
    for (const seed of Object.values(seeds)) assertAttributeSeed(seed);
  }

  definitions(market: MarketContext): readonly SeededDefinition[] {
    return this.#seeds[market.marketId]?.definitions ?? [];
  }

  families(market: MarketContext): readonly SeededFamily[] {
    return this.#seeds[market.marketId]?.families ?? [];
  }
}
