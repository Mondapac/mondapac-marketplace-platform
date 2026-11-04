/**
 * The languages a service area name may be written in: English (required, the fallback) and the
 * two the buyer site is built for (Persian, Modern Standard Arabic). Writing a name does not
 * publish a language: the storefront serves one only once the Market has published it (the
 * pre-publish gate).
 */
// Temporary: replaced by the Market's language registry when the admin language module (W3) exists.
export const AREA_NAME_LANGUAGES = ['en', 'fa', 'ar'] as const;

export const AREA_NAME_DEFAULT_LANGUAGE = 'en';

/** The languages of a Market's names: the built-in list plus any language its configuration already uses. */
export function languagesOf(
  configuredNames: readonly Readonly<Record<string, string>>[],
): string[] {
  const all = new Set<string>(AREA_NAME_LANGUAGES);
  for (const names of configuredNames) for (const language of Object.keys(names)) all.add(language);
  return [...all];
}
