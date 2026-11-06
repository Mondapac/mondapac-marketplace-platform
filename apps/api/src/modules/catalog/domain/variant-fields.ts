/**
 * The fixed list of fields that belong to one variant and not to the product (variants V4,
 * plan decision 7). Everything else stays a product-level attribute. A field that is `null` takes
 * the product's value (shipping) or means "none" (GTIN, images).
 */
export const VARIANT_FIELD_LIMITS = {
  /** Shipping weight in grams: 1 to 1,000,000 (1 t). */
  weightGramsMax: 1_000_000,
  /** Each shipping dimension in millimetres: 1 to 100,000 (100 m). */
  dimensionMmMax: 100_000,
  /** Images one variant may pick from the product gallery. */
  imagesMax: 20,
} as const;

export const isPositiveInt = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= max;
