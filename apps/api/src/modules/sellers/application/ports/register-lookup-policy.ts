import type { MarketContext } from '@mondapac/shared-kernel';

/**
 * The register-lookup values of a Market (sellers design 4.1: `sellers.registerLookup.*`),
 * read through a port like every other Market value. `none` is the default of a Market that
 * configures no register: no call, no quota, no result, and the file stays "not performed".
 */
export type RegisterLookupSettings =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'configured';
      /** The code of an adapter in `infrastructure/register-lookups/`. */
      readonly adapter: string;
      /** `registerLookup.maxResultAge`, in whole days (30 in the launch Market). */
      readonly maxResultAgeDays: number;
      /** `registerLookup.perAccountLimit`: new identifier values per account per 24 h. */
      readonly perAccountLimit: number;
      /** `registerLookup.perOriginLimit`: calls per origin per 24 h. */
      readonly perOriginLimit: number;
      /** `registerLookup.marketDailyBudget`: calls per Market per 24 h. */
      readonly marketDailyBudget: number;
      /** The Market's list of legal suffixes dropped from names before they are compared. */
      readonly legalSuffixes: readonly string[];
    };

export interface RegisterLookupPolicy {
  /** Never falls back to another Market's values; a Market with no register is `none`. */
  settingsOf(market: MarketContext): RegisterLookupSettings;
}

export const REGISTER_LOOKUP_POLICY = Symbol('REGISTER_LOOKUP_POLICY');
