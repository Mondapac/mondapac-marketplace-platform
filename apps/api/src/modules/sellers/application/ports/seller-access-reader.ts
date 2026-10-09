import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { AccessState } from '../../domain/seller-status';

/**
 * The access state `identity` holds for a seller (sellers design 3.3, 7.2; ADR-0022 decision 2),
 * read live and never copied. Called outside any unit of work (PP 3.1 row 5), with the caller's
 * `CallContext` unchanged. Null when `identity` does not know the seller in the Market (a seller
 * of another Market and an unknown id answer alike, AC 1). The adapter throws when `identity`
 * refuses or cannot answer: the caller answers `sellers.unavailable`, never a guessed state.
 */
export interface SellerAccessReader {
  accessOf(context: CallContext, sellerId: Id<'Seller'>): Promise<AccessState | null>;
}

export const SELLER_ACCESS_READER = Symbol('SELLER_ACCESS_READER');
