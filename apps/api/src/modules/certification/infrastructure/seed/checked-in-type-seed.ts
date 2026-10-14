import type { MarketContext } from '@mondapac/shared-kernel';
import type { CertificationTypeSeed, SeededType } from '../../application/ports/type-seed';
import { isCertificationTypeCode } from '../../domain/type-revision';
import { loadFileTypeSeeds } from './file-type-seed';
import { ZZ_CERTIFICATION_TYPES } from './zz.types.seed';

/** A seed that breaks a rule of design 5.2: refused at boot and by the unit test. */
export class CertificationTypeSeedError extends Error {}

const defaultSeeds = (): Readonly<Record<string, readonly SeededType[]>> => ({
  ...loadFileTypeSeeds(),
  ZZ: ZZ_CERTIFICATION_TYPES,
});

/** A type code appears once per Market; the revision rules are `validateTypeRevision`'s. */
export function assertTypeSeed(types: readonly SeededType[]): void {
  const seen = new Set<string>();
  for (const type of types) {
    if (!isCertificationTypeCode(type.code)) {
      throw new CertificationTypeSeedError(`Seed type code "${String(type.code)}" is not a valid code`);
    }
    if (seen.has(type.code)) {
      throw new CertificationTypeSeedError(`Seed type "${type.code}" is listed twice`);
    }
    seen.add(type.code);
  }
}

/** The checked-in seeds by Market id; a Market with none has no type. */
export class CheckedInTypeSeed implements CertificationTypeSeed {
  readonly #seeds: Readonly<Record<string, readonly SeededType[]>>;

  constructor(seeds: Readonly<Record<string, readonly SeededType[]>> = defaultSeeds()) {
    this.#seeds = seeds;
    for (const types of Object.values(seeds)) assertTypeSeed(types);
  }

  types(market: MarketContext): readonly SeededType[] {
    return this.#seeds[market.marketId] ?? [];
  }
}
