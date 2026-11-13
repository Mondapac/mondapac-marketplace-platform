/**
 * The Market locale English-only seller emails name things in (attributes A4-4: "product and
 * detail names are the English catalogue names"): the default locale when it is English, else the
 * first English supported locale, else the default (names then fall back to codes). Language by
 * its BCP 47 primary subtag; no Market is named.
 */
export function englishLocaleOf(locales: {
  readonly default: string;
  readonly supported: readonly string[];
}): string {
  const isEnglish = (tag: string) => tag.toLowerCase().split('-')[0] === 'en';
  if (isEnglish(locales.default)) return locales.default;
  return locales.supported.find(isEnglish) ?? locales.default;
}
