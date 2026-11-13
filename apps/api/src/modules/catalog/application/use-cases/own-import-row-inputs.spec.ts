import type {
  SellerGroupPlan,
  SellerProductPatch,
  SellerVariantPlan,
} from '../../domain/seller-import/row-check';
import type { OwnOfferCreateOnPlatformProductInput } from './own-offer-create-on-platform-product.use-case';
import type { OwnOfferEditInput } from './own-offer-edit.use-case';
import type { OwnImportRowSaveInput } from './own-import-row-save.use-case';

// The seller import has no way to carry a certification (catalog design 14c, hard rule): the plan
// of a group and the inputs of the row use cases have no field for a tag, a claim, a basis, a
// certificate, a handling, an attestation, a self-declaration, a status, a publish flag, a price,
// a cost or a stock level. The first half is checked by the compiler (a new such field fails the
// build of this file); the second half lists the keys, so a failure names the field.

type Forbidden =
  | 'certif'
  | 'tag'
  | 'claim'
  | 'basis'
  | 'handling'
  | 'attest'
  | 'declar'
  | 'status'
  | 'publish'
  | 'price'
  | 'cost'
  | 'stock'
  | 'halal'
  | 'kosher';

type Leaks<T> = {
  [K in keyof T & string]: Lowercase<K> extends `${string}${Forbidden}${string}` ? K : never;
}[keyof T & string];

// Compile-time: each of these must be `never`, or the assignment below does not compile.
const noLeak = {
  plan: true as [Leaks<SellerGroupPlan>] extends [never] ? true : false,
  product: true as [Leaks<SellerProductPatch>] extends [never] ? true : false,
  variant: true as [Leaks<SellerVariantPlan>] extends [never] ? true : false,
  rowSave: true as [Leaks<OwnImportRowSaveInput>] extends [never] ? true : false,
  offerCreate: true as [Leaks<OwnOfferCreateOnPlatformProductInput>] extends [never] ? true : false,
  offerEdit: true as [Leaks<OwnOfferEditInput>] extends [never] ? true : false,
};

// The same, as exact key lists, so a new field is a visible change of this file.
const planKeys: Record<keyof SellerGroupPlan, true> = {
  mode: true,
  kind: true,
  groupRow: true,
  sellerSku: true,
  conditionCode: true,
  offerDescription: true,
  existing: true,
  catalogueProduct: true,
  product: true,
  variants: true,
};
const productKeys: Record<keyof SellerProductPatch, true> = {
  typeCode: true,
  title: true,
  shortDescription: true,
  description: true,
  categoryId: true,
  taxCategoryCode: true,
  attributeValues: true,
  imageNames: true,
  axes: true,
};
const variantKeys: Record<keyof SellerVariantPlan, true> = {
  rowNumber: true,
  optionValues: true,
  optionKey: true,
  existingVariantId: true,
  gtin: true,
  shippingWeightGrams: true,
  shippingLengthMm: true,
  shippingWidthMm: true,
  shippingHeightMm: true,
};
const offerKeys: Record<keyof OwnOfferEditInput, true> = {
  offerId: true,
  sellerSku: true,
  conditionCode: true,
  description: true,
};

describe('the seller import carries no certification field', () => {
  it('has no such field in the plan of a group or its parts', () => {
    expect(Object.values(noLeak).every((value) => value)).toBe(true);
    for (const keys of [planKeys, productKeys, variantKeys]) {
      expect(
        Object.keys(keys).filter((key) =>
          /certif|tag|claim|basis|attest|declar|status|publish|price|cost|stock/i.test(key),
        ),
      ).toEqual([]);
    }
  });

  it('has none in the inputs of the row use cases, which stay closed', () => {
    expect(Object.keys(offerKeys).sort()).toEqual([
      'conditionCode',
      'description',
      'offerId',
      'sellerSku',
    ]);
    const rowSave: Record<keyof OwnImportRowSaveInput, true> = { productId: true, plan: true };
    expect(Object.keys(rowSave).sort()).toEqual(['plan', 'productId']);
  });
});
