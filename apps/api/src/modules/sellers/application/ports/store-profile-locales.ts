import type { MarketContext } from '@mondapac/shared-kernel';

/** The locales of the Market a store's text may be written in (Market configuration). */
export interface StoreProfileLocales {
  readonly defaultLocale: string;
  readonly supportedLocales: readonly string[];
}

export interface StoreProfileLocalesPolicy {
  /** The Market's locales; throws for a Market this Region Stack does not host. */
  locales(market: MarketContext): StoreProfileLocales;
}

export const STORE_PROFILE_LOCALES_POLICY = Symbol('STORE_PROFILE_LOCALES_POLICY');
