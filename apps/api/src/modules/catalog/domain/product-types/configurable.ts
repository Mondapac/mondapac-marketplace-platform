import { validateAttributeValues } from '@mondapac/shared-kernel';
import type { AttributeField, AttributeSchema } from '@mondapac/shared-kernel';
import type {
  ProductTypeHandler,
  VariantDraft,
  VariantIssue,
  VariantValidationResult,
} from '../product-type-handler';

/**
 * The Configurable type (catalog design 3.2): at least one option attribute of the family with
 * type `select`; each variant has exactly one value per option attribute, from that attribute's
 * options, and the combination is unique within the product. At least one variant (CC2) and at
 * most `maxVariants` (Market configuration `maxVariantsPerProduct`).
 */
export const configurableProductType: ProductTypeHandler = Object.freeze({
  typeCode: 'configurable',
  variantModel: 'options',
  validateAttributes: validateAttributeValues,
  validateVariants(
    schema: AttributeSchema,
    variants: readonly VariantDraft[],
    maxVariants: number,
  ): VariantValidationResult {
    const issues: VariantIssue[] = [];
    const optionFields = schema.fields.filter(
      (field: AttributeField) => field.isVariantOption && field.dataType === 'select',
    );
    if (optionFields.length === 0) {
      return {
        ok: false,
        issues: [{ path: 'variants', code: 'variants.option-attribute-missing' }],
      };
    }
    if (variants.length === 0) issues.push({ path: 'variants', code: 'variants.none' });
    if (variants.length > maxVariants) issues.push({ path: 'variants', code: 'variants.too-many' });

    const seen = new Set<string>();
    variants.forEach((variant, index) => {
      const path = `variants[${index}]`;
      const known = new Set(optionFields.map((field) => field.code));
      if (Object.keys(variant.optionValues).some((code) => !known.has(code))) {
        issues.push({ path, code: 'variants.option-unknown' });
      }
      const parts: string[] = [];
      for (const field of optionFields) {
        const chosen = Object.hasOwn(variant.optionValues, field.code)
          ? variant.optionValues[field.code]
          : undefined;
        if (chosen === undefined) {
          issues.push({ path, code: 'variants.option-missing' });
        } else if (!(field.bounds.options ?? []).some((option) => option.code === chosen)) {
          issues.push({ path, code: 'variants.option-unknown' });
        } else {
          parts.push(JSON.stringify([field.code, chosen]));
        }
      }
      if (parts.length === optionFields.length) {
        const key = parts.join('|');
        if (seen.has(key)) issues.push({ path, code: 'variants.duplicate-combination' });
        seen.add(key);
      }
    });
    return issues.length === 0 ? { ok: true } : { ok: false, issues };
  },
});
