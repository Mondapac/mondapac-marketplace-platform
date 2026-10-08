import { validateAttributeValues } from '@mondapac/shared-kernel';
import type {
  ProductTypeHandler,
  VariantDraft,
  VariantIssue,
  VariantValidationResult,
} from '../product-type-handler';
import type { AttributeSchema } from '@mondapac/shared-kernel';

/**
 * The Simple type (catalog design 3.1 row 3, 3.2): one variant, created with the product, with
 * no option values. It is a structural type, so core registers it.
 */
export const simpleProductType: ProductTypeHandler = Object.freeze({
  typeCode: 'simple',
  variantModel: 'single',
  validateAttributes: validateAttributeValues,
  validateVariants(
    _schema: AttributeSchema,
    variants: readonly VariantDraft[],
  ): VariantValidationResult {
    const issues: VariantIssue[] = [];
    if (variants.length === 0) issues.push({ path: 'variants', code: 'variants.none' });
    if (variants.length > 1) issues.push({ path: 'variants', code: 'variants.too-many' });
    if (variants.some((variant) => Object.keys(variant.optionValues).length > 0)) {
      issues.push({ path: 'variants[0]', code: 'variants.option-unknown' });
    }
    return issues.length === 0 ? { ok: true } : { ok: false, issues };
  },
});
