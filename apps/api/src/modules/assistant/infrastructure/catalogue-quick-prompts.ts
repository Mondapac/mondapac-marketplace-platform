import type { MarketContext } from '@mondapac/shared-kernel';
import type { LocaleCatalogues } from '../../../platform/i18n/locale-catalogues';
import type { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { QuickPrompts } from '../application/ports/quick-prompts';

/** At most this many prompts are read: `assistant.quick-prompt.1` to `.6`, in order. */
export const MAX_QUICK_PROMPTS = 6;
/** A prompt is a short button text. */
export const MAX_QUICK_PROMPT_LENGTH = 80;

// A storefront language tag as sent: a BCP 47 shape, short. Anything else counts as none.
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;

/** A hosted Market's default locale has no quick prompt, or one is not a short button text. */
export class InvalidQuickPromptsError extends Error {
  override readonly name = 'InvalidQuickPromptsError';
  constructor(marketId: string, locale: string, problem: string) {
    super(`assistant quick prompts of Market ${marketId} (${locale}): ${problem}`);
  }
}

function promptsOf(messages: Readonly<Record<string, string>> | null): string[] {
  const prompts: string[] = [];
  for (let n = 1; n <= MAX_QUICK_PROMPTS; n++) {
    const text = messages?.[`assistant.quick-prompt.${n}`];
    if (text === undefined) break;
    prompts.push(text);
  }
  return prompts;
}

/**
 * {@link QuickPrompts} from the translation catalogues. Checked at boot: every hosted Market's
 * default locale has 1 to 6 prompts of at most 80 characters (the catalogue loader already
 * refused control and format characters). The buyer's locale is used when the
 * Market lists it (an exact tag, else the first supported locale of the same language), and its
 * catalogue has prompts; otherwise the Market's default.
 */
export class CatalogueQuickPrompts implements QuickPrompts {
  readonly #byMarket = new Map<
    string,
    { readonly supported: readonly string[]; readonly byLocale: Map<string, readonly string[]> }
  >();
  readonly #defaults = new Map<string, readonly string[]>();

  constructor(markets: MarketRegistry, catalogues: LocaleCatalogues) {
    for (const marketId of markets.hostedMarketIds()) {
      const config = markets.get(marketId);
      const byLocale = new Map<string, readonly string[]>();
      for (const locale of config.supportedLocales) {
        const prompts = promptsOf(catalogues.messages('assistant', locale));
        const long = prompts.find((text) => Array.from(text).length > MAX_QUICK_PROMPT_LENGTH);
        if (long !== undefined) {
          throw new InvalidQuickPromptsError(marketId, locale, 'a prompt is over 80 characters');
        }
        if (prompts.length > 0) byLocale.set(locale, Object.freeze(prompts));
      }
      const defaults = byLocale.get(config.defaultLocale);
      if (defaults === undefined) {
        throw new InvalidQuickPromptsError(
          marketId,
          config.defaultLocale,
          'assistant.quick-prompt.1 is missing',
        );
      }
      this.#byMarket.set(marketId, { supported: config.supportedLocales, byLocale });
      this.#defaults.set(marketId, defaults);
    }
  }

  forBuyer(market: MarketContext, lang: string | null): readonly string[] {
    const entry = this.#byMarket.get(market.marketId);
    const defaults = this.#defaults.get(market.marketId);
    if (entry === undefined || defaults === undefined) return [];
    if (lang === null || !LANGUAGE_TAG.test(lang)) return defaults;
    const wanted = lang.toLowerCase();
    const language = wanted.split('-')[0]!;
    const exact = entry.supported.find((locale) => locale.toLowerCase() === wanted);
    const sameLanguage = entry.supported.find(
      (locale) => locale.toLowerCase().split('-')[0] === language,
    );
    const chosen = exact ?? sameLanguage;
    return (chosen === undefined ? undefined : entry.byLocale.get(chosen)) ?? defaults;
  }
}
