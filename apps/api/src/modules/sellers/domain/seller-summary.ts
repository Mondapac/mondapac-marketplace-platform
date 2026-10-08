import type { Id } from '@mondapac/shared-kernel';

/**
 * One answer of `sellerSummaries` (sellers design 7.1). Slice 1 knows whether the file exists;
 * the zone, the slug and the public store name join the answer with the slices that create them.
 */
export interface SellerSummary {
  readonly sellerId: Id<'Seller'>;
  readonly exists: boolean;
}
