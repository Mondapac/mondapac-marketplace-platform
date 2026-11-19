import { useTranslations } from 'next-intl';

/** A tax category of the Market with the message key it is shown by (from its Market file). */
export interface TaxCategory {
  readonly code: string;
  readonly labelKey: string;
}

/** Abbreviations that stay in capitals when a code is shown as words (`gst-free` is `GST free`). */
const ACRONYMS: ReadonlySet<string> = new Set(['gst', 'vat', 'abn', 'sku', 'gtin', 'url', 'id']);

/** A code from the API as readable text (`dry-goods` to `Dry goods`, `gst_free_food` to `GST free food`). */
export function readable(code: string): string {
  const words = code
    .replace(/[-_]+/g, ' ')
    .trim()
    .split(' ')
    .map((word) => (ACRONYMS.has(word.toLowerCase()) ? word.toUpperCase() : word));
  const text = words.join(' ');
  return text === '' ? code : text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The tax category select options: each category is named by the message its `labelKey` points
 * at (the Market configuration decides the key); a key without a message falls back to the code
 * shown as words.
 */
export function useTaxCategoryOptions(
  categories: readonly TaxCategory[],
): { value: string; label: string }[] {
  const t = useTranslations();
  return categories.map(({ code, labelKey }) => ({
    value: code,
    label: t.has(labelKey) ? t(labelKey) : readable(code),
  }));
}
