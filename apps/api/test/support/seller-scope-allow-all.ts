import { ok } from '@mondapac/shared-kernel';
import type {
  AllowedCategoryIds,
  SellerCategoryScope,
} from '../../src/modules/catalog/application/business-activities/allowed-category-ids';

/**
 * A seller category scope that allows every category: for a db spec whose seller submits are not
 * about the business-activity scope (the scope itself is covered by its own specs).
 */
export const ALL_CATEGORIES_IN_SCOPE: Pick<SellerCategoryScope, 'allowedCategoryIdsForSeller'> = {
  allowedCategoryIdsForSeller: () =>
    Promise.resolve(ok({ has: () => true } as unknown as AllowedCategoryIds)),
};
