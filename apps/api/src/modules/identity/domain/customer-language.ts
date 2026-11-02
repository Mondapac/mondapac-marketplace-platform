import { err, ok, type Result } from '@mondapac/shared-kernel';

/**
 * The languages a buyer can keep on the profile: English, the default, and the two the buyer
 * site is built for (Persian, Modern Standard Arabic; both read right to left). Keeping one is not
 * publishing it: the storefront serves a language only once the Market has published it (the
 * pre-publish gate), and until then every request reads in English.
 */
export const CUSTOMER_LANGUAGES = ['en', 'fa', 'ar'] as const;

export type CustomerLanguage = (typeof CUSTOMER_LANGUAGES)[number];

export type CustomerLanguageInvalid = { readonly code: 'customer-language.invalid' };

/** A language from {@link CUSTOMER_LANGUAGES}, or null for "no choice" (English). */
export function parseCustomerLanguage(
  raw: unknown,
): Result<CustomerLanguage | null, CustomerLanguageInvalid> {
  if (raw === null) return ok(null);
  if (typeof raw !== 'string' || !(CUSTOMER_LANGUAGES as readonly string[]).includes(raw)) {
    return err({ code: 'customer-language.invalid' });
  }
  return ok(raw as CustomerLanguage);
}
