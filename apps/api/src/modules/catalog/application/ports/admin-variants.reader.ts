import type { Id, MarketContext } from '@mondapac/shared-kernel';

/** One option of a variant on one axis, with its label in the asked locale. */
export interface AdminVariantOption {
  readonly attributeCode: string;
  readonly optionCode: string;
  readonly label: string;
}

/** One row of the admin variant file: a variant of a product's published revision. */
export interface AdminVariantRow {
  readonly productId: Id<'Product'>;
  readonly productCode: string;
  readonly typeCode: string;
  readonly variantCode: string;
  readonly options: readonly AdminVariantOption[];
  /** The GTIN as 14 digits; null when the variant has none. */
  readonly gtin: string | null;
  /** Offers of the product that are not deleted, of every seller (`catalog`'s own aggregate). */
  readonly offerCount: number;
}

/**
 * The variants of the admin variant export (catalog design 14b). Runs in the open (read-only) unit
 * of the use case, through the Market-scoped client, and reads catalog tables only: no price, no
 * stock. Only the **published** revision of a product is read: a product never published has no
 * row, and a `proposed` variant that exists only in a pending revision or the working copy has
 * none either.
 */
export interface AdminVariantsReader {
  /** How many rows `rows` would give for these products. */
  count(market: MarketContext, productIds: readonly Id<'Product'>[]): Promise<number>;

  /** The attribute codes the variants of these products vary on, sorted, without repeats. */
  axisCodes(
    market: MarketContext,
    productIds: readonly Id<'Product'>[],
  ): Promise<readonly string[]>;

  /**
   * The rows of these products, in the order of `productIds` and, within a product, by variant
   * number. A product that is unknown or never published gives none.
   */
  rows(
    market: MarketContext,
    productIds: readonly Id<'Product'>[],
    locale: string,
  ): Promise<readonly AdminVariantRow[]>;
}

export const ADMIN_VARIANTS_READER = Symbol('ADMIN_VARIANTS_READER');
