import type { MarketContext } from '@mondapac/shared-kernel';

/** The Market's settings of the "Email sellers" mail (attributes package A4-4), from configuration. */
export interface MissingDetailsMailSettings {
  /** The Market's mail sender (the one identity's mail uses). */
  sender(market: MarketContext): { readonly address: string; readonly name: string };
  /** The seller panel's Products page the mail links to; null when the Market has none. */
  productsPage(market: MarketContext): string | null;
}

export const MISSING_DETAILS_MAIL_SETTINGS = Symbol('CATALOG_MISSING_DETAILS_MAIL_SETTINGS');
