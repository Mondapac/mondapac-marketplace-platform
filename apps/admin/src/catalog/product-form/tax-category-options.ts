import { useTranslations } from 'next-intl';
import { readable, type TaxCategory } from './types.ts';

/**
 * The tax category select options: each category is named by the message its `labelKey` points
 * at (the Market configuration decides the key); a category without a key, or a key without a
 * message, falls back to its code shown as words.
 */
export function useTaxCategoryOptions(
  codes: readonly string[],
  categories: readonly TaxCategory[] | undefined,
): { value: string; label: string }[] {
  const t = useTranslations();
  return codes.map((code) => {
    const key = categories?.find((category) => category.code === code)?.labelKey;
    return { value: code, label: key !== undefined && t.has(key) ? t(key) : readable(code) };
  });
}
