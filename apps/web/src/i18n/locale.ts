// Which language a request is served in (ADR-0002; buyer i18n base). The site is English for
// everyone until a Market publishes another language; a language is chosen only in the signed-in
// buyer's profile. No URL prefix, no switcher, no Accept-Language: guests and crawlers get English.

export const DEFAULT_LOCALE = 'en';

/**
 * The languages published for the Market. Seam for the admin's per-Market publishing (W3): it
 * replaces this constant with the Market's list; the default is always part of it.
 */
export function publishedLocales(): readonly string[] {
  return [DEFAULT_LOCALE];
}

/** The request's language: the profile's, when it is a published one; English otherwise. */
export function resolveLocale(
  profileLocale: string | null | undefined,
  published: readonly string[] = publishedLocales(),
): string {
  if (typeof profileLocale !== 'string') return DEFAULT_LOCALE;
  let canonical: string;
  try {
    canonical = Intl.getCanonicalLocales(profileLocale.trim())[0] ?? '';
  } catch {
    return DEFAULT_LOCALE;
  }
  return published.includes(canonical) ? canonical : DEFAULT_LOCALE;
}

/** Scripts that read right to left, for runtimes without `Intl.Locale.getTextInfo`. */
const RTL_LANGUAGES: ReadonlySet<string> = new Set([
  'ar',
  'fa',
  'he',
  'ur',
  'ps',
  'sd',
  'ug',
  'yi',
  'dv',
  'ckb',
]);

type WithTextInfo = Intl.Locale & {
  getTextInfo?: () => { direction: 'ltr' | 'rtl' };
  textInfo?: { direction: 'ltr' | 'rtl' };
};

/** The writing direction of a language. */
export function directionOf(locale: string): 'ltr' | 'rtl' {
  try {
    const tag = new Intl.Locale(locale) as WithTextInfo;
    const info = tag.getTextInfo?.() ?? tag.textInfo;
    if (info) return info.direction;
    return RTL_LANGUAGES.has(tag.language) ? 'rtl' : 'ltr';
  } catch {
    return 'ltr';
  }
}

/** The language tag without Unicode extensions: what `lang` and the catalogue name carry. */
export function languageTag(locale: string): string {
  return locale.replace(/-u-.*$/i, '');
}

/**
 * The locale to hand to Intl: the language's own wording and order, but Latin digits and the
 * Gregorian calendar in every language (owner decision).
 * The request's locale is this tag (src/i18n/request.ts), so next-intl's own number, plural and
 * date formatting follows the same rule; `lang`, the catalogue and fonts use `languageTag`.
 */
export function intlLocale(locale: string): string {
  try {
    return new Intl.Locale(locale, { numberingSystem: 'latn', calendar: 'gregory' }).toString();
  } catch {
    return `${DEFAULT_LOCALE}-u-ca-gregory-nu-latn`;
  }
}

/**
 * The key of a keyboard event with the arrows read in the page's direction: ArrowRight always
 * means "next" in a row of tabs, which is the left arrow when the page reads right to left.
 */
export function arrowInReadingOrder(event: {
  readonly key: string;
  readonly currentTarget: EventTarget;
}): string {
  const target = event.currentTarget;
  const rtl =
    target instanceof Element &&
    (getComputedStyle(target).direction === 'rtl' ||
      target.closest('[dir]')?.getAttribute('dir') === 'rtl');
  if (!rtl || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return event.key;
  return event.key === 'ArrowLeft' ? 'ArrowRight' : 'ArrowLeft';
}
