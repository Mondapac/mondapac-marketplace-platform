import type {
  AttributeSchema,
  AttributeValues,
  Locale,
  ValidationResult,
} from '@mondapac/shared-kernel';

/** The code of a registered product type: `simple`, `configurable` or a Vertical's own. */
export type ProductTypeCode = string;

/** How a type's variants are modelled: one fixed variant, or variants defined by options. */
export type VariantModel = 'single' | 'options';

/** A variant as the working copy states it: one option value per option attribute. */
export interface VariantDraft {
  /** Field code of the option attribute to the code of the chosen option. */
  readonly optionValues: { readonly [attributeCode: string]: string };
}

/** Where and why a set of variants is refused. Codes only, never a value. */
export interface VariantIssue {
  readonly path: string;
  readonly code:
    | 'variants.none'
    | 'variants.too-many'
    | 'variants.option-missing'
    | 'variants.option-unknown'
    | 'variants.option-attribute-missing'
    | 'variants.duplicate-combination';
}

export type VariantValidationResult =
  { readonly ok: true } | { readonly ok: false; readonly issues: readonly VariantIssue[] };

/**
 * The extension point `catalog.product-type` (catalog design 3.2). Handlers are pure: no I/O, no
 * clock, so the domain may call them. `computeAvailability` is deliberately not part of it
 * (ADR-0024 decision 5), and `renderSummary` joins in slice 4 with the revision it renders.
 * `validateAttributes` takes the Market's locales as a third argument (design 3.3: the default
 * locale, first, is the only required one).
 */
export interface ProductTypeHandler {
  readonly typeCode: ProductTypeCode;
  readonly variantModel: VariantModel;
  validateAttributes(
    schema: AttributeSchema,
    values: AttributeValues,
    locales: readonly Locale[],
  ): ValidationResult;
  validateVariants(
    schema: AttributeSchema,
    variants: readonly VariantDraft[],
    maxVariants: number,
  ): VariantValidationResult;
}

/** The registry's validator for the point: the shape of a handler, nothing more. */
export function isProductTypeHandler(value: unknown): value is ProductTypeHandler {
  if (typeof value !== 'object' || value === null) return false;
  const handler = value as Partial<ProductTypeHandler>;
  return (
    typeof handler.typeCode === 'string' &&
    (handler.variantModel === 'single' || handler.variantModel === 'options') &&
    typeof handler.validateAttributes === 'function' &&
    typeof handler.validateVariants === 'function'
  );
}

/** The id of the extension point, `<owning module>.<point>`. */
export const PRODUCT_TYPE_POINT = 'catalog.product-type';
