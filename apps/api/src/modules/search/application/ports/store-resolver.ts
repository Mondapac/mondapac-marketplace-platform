import type { CallContext, Id } from '@mondapac/shared-kernel';

/**
 * Which seller holds a store address, under the published-store rules (an approved revision, a
 * held slug, the seller may sell now). `sellerId: null` is every "no such store" (unknown,
 * malformed, retired, not selling), byte-identical. `null` when the read was refused or failed:
 * the caller fails closed (`search.unavailable`), never a list that ignores the store.
 */
export interface StoreResolver {
  sellerIdOf(
    context: CallContext,
    slug: string,
  ): Promise<{ readonly sellerId: Id<'Seller'> | null } | null>;
}

export const STORE_RESOLVER = Symbol('STORE_RESOLVER');
