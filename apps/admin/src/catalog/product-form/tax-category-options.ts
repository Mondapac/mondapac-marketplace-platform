import { useTranslations } from 'next-intl';
import { readable, type TaxCategory } from './types.ts';

/**
 * The tax category select options: each category is named by the message its `labelKey` points
 * at (the Market configuration decides the key); a category whose key has no
 * message, falls back to its code shown as words.
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
