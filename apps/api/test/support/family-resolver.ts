import type { ProductFamilyResolver } from '../../src/modules/catalog/application/attributes/product-family-resolver';

/**
 * A family resolver that always answers one feature set code (the product's own, in specs that do
 * not exercise CAT-10), as the real one does for a Market whose categories hold no feature set.
 */
export function fixedFamilyResolver(familyCode = 'default'): ProductFamilyResolver {
  return {
    open: () => Promise.resolve({ resolve: () => Promise.resolve({ ok: true, familyCode }) }),
    resolve: () => Promise.resolve({ ok: true, familyCode }),
  } as unknown as ProductFamilyResolver;
}
