import type { SourceView } from '../stock/types.ts';
import { pickLabel } from './draft-content.ts';
import type { ProductView } from './types.ts';
import type { FileAxis, FileModel, FileVariant } from './variant-file.ts';
import type { TableRow } from './variants-table-logic.ts';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * What the variant file needs of an Offer's product, from what the Variants tab already read: the
 * product (codes, the published revision's options and GTINs, the field options and their labels),
 * the price and stock of every row, and the seller's locations. The options and GTINs are the
 * PUBLISHED revision's, as the storefront shows them; a variant that is not in it has none.
 */
export function fileModelOf({
  product,
  rows,
  sources,
  currency,
  locale,
  canEditPrice,
  canEditStock,
  canEditSellUnits,
}: {
  readonly product: ProductView;
  readonly rows: readonly TableRow[];
  readonly sources: readonly SourceView[];
  /** The Market currency; null when the seller may not see prices. */
  readonly currency: string | null;
  readonly locale: string;
  readonly canEditPrice: boolean;
  readonly canEditStock: boolean;
  readonly canEditSellUnits: boolean;
}): FileModel {
  const stored = product.published?.content['variants'];
  const entries = Array.isArray(stored) ? stored.filter(isObject) : [];
  const entryOf = (variantId: string) => entries.find((item) => item['variantId'] === variantId);
  const optionsOf = (variantId: string): Record<string, string> => {
    const values = entryOf(variantId)?.['optionValues'];
    return isObject(values)
      ? Object.fromEntries(
          Object.entries(values).filter(
            (pair): pair is [string, string] => typeof pair[1] === 'string',
          ),
        )
      : {};
  };

  const used = new Set(
    product.variants.flatMap((variant) => Object.keys(optionsOf(variant.variantId))),
  );
  const axes: FileAxis[] = [...used].sort().map((code) => {
    const field = product.form.fields.find((item) => item.code === code);
    return {
      code,
      options:
        field?.options.map((option) => ({
          code: option.code,
          label: pickLabel(option.labels, locale, option.code),
        })) ?? [],
    };
  });

  const variants: FileVariant[] = product.variants.map((variant) => {
    const row = rows.find((item) => item.variantId === variant.variantId);
    const gtin = entryOf(variant.variantId)?.['gtin'];
    return {
      variantId: variant.variantId,
      variantCode: variant.variantCode,
      state:
        variant.state === 'retired' || variant.state === 'proposed' ? variant.state : 'published',
      options: optionsOf(variant.variantId),
      gtin: typeof gtin === 'string' ? gtin : '',
      variantSku: row?.variantSku ?? '',
      selling: row?.selling ?? true,
      price: row?.price?.inForce?.amount ?? null,
      stock: Object.fromEntries(
        Object.entries(row?.stock ?? {}).flatMap(([sourceId, cell]) =>
          cell === undefined ? [] : [[sourceId, { onHand: cell.onHand }] as const],
        ),
      ),
    };
  });

  return {
    productCode: product.productCode,
    currency: currency ?? '',
    axes,
    variants,
    sources: sources.map((source) => ({ id: source.id, name: source.name })),
    showPrice: currency !== null,
    showStock: sources.length > 0,
    canEditPrice: canEditPrice && currency !== null,
    canEditStock: canEditStock && sources.length > 0,
    canEditSellUnits,
    maxRows: product.maxVariants,
  };
}
