// The Add page's starting product. Plain module, no 'use client': the Add page (a server component)
// calls blankProduct, and a server file may not call a function a client module exports.
import type { ProductOptions, ProductView } from './types.ts';

/**
 * The product the Add page starts from. Nothing exists on the server yet, so the variants and the
 * draft are empty; the category list and tax category codes come from the options read. The first
 * Save draft creates the product (see EditForm).
 */
export function blankProduct(options: ProductOptions): ProductView {
  return {
    productId: '',
    productCode: '',
    typeCode: '',
    familyCode: '',
    variantModel: 'single',
    status: 'draft',
    pausedAt: null,
    variants: [],
    maxVariants: 0,
    sensitiveFields: [],
    lastChangedAt: '',
    createdAt: '',
    pendingSubmittedAt: null,
    form: {
      taxCategories: options.taxCategories,
      units: [],
      fields: [],
      categories: options.categories,
    },
    workingCopy: null,
    published: null,
    pending: null,
  };
}

/** The condition a new offer starts on: "new" when the Market offers it. */
export function defaultCondition(options: ProductOptions): string {
  return options.conditions.includes('new') ? 'new' : '';
}
