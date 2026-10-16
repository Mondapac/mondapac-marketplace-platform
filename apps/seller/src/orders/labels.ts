import { pickLabel } from '../catalog/draft-content.ts';
import type { ProductView } from '../catalog/types.ts';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringMap = (value: unknown): value is Record<string, string> =>
  isObject(value) && Object.values(value).every((item) => typeof item === 'string');

/**
 * The variant of a product as a seller reads it ("1 kg"): the label the seller gave it, else
 * the labels of its option values joined ("Red / Large"). The published revision wins over the
 * working copy. Null when the product says nothing about that variant.
 */
export function variantLabelOf(
  product: Pick<ProductView, 'published' | 'workingCopy' | 'form'>,
  variantId: string,
  locale: string,
): string | null {
  for (const content of [product.published?.content, product.workingCopy?.content]) {
    const list = content?.['variants'];
    const entry = Array.isArray(list)
      ? (list as unknown[]).find((item) => isObject(item) && item['variantId'] === variantId)
      : undefined;
    if (!isObject(entry)) continue;
    const labels = entry['labels'];
    if (isStringMap(labels)) {
      const text = pickLabel(labels, locale, '').trim();
      if (text !== '') return text;
    }
    const options = entry['optionValues'];
    if (isStringMap(options)) {
      const parts = product.form.fields
        .filter((field) => field.isVariantOption)
        .map((field) => {
          const option = field.options.find((item) => item.code === options[field.code]);
          return option === undefined ? null : pickLabel(option.labels, locale, option.code);
        })
        .filter((part): part is string => part !== null);
      if (parts.length > 0) return parts.join(' / ');
    }
  }
  return null;
}
