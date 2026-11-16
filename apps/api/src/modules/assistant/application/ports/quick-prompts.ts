import type { MarketContext } from '@mondapac/shared-kernel';

/**
 * The storefront's quick prompts (the buttons under the welcome text): a fixed server list in
 * the translation catalogues (`config/locales/<locale>/assistant.json`), never model output and
 * never a setting. The locale is the buyer's when the Market supports it, else the Market's
 * default.
 */
export interface QuickPrompts {
  /** `lang` is the storefront's language tag as sent (untrusted); null for none. */
  forBuyer(market: MarketContext, lang: string | null): readonly string[];
}

export const QUICK_PROMPTS = Symbol('ASSISTANT_QUICK_PROMPTS');
