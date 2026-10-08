import type { CallContext, Id } from '@mondapac/shared-kernel';

/** One page of the sellers `identity` has registered, by id (sellers design R-6). */
export interface RegisteredSellerPage {
  readonly items: readonly {
    readonly sellerId: Id<'Seller'>;
    readonly origin: 'self' | 'invitation';
  }[];
  /** The `after` of the next page, or null after the last page. */
  readonly next: Id<'Seller'> | null;
}

/**
 * The registered sellers of the context's Market, paged by id, for the backfill. The adapter
 * calls `identity`; it throws when `identity` refuses, so a run that cannot read ends and the
 * next run starts again.
 */
export interface RegisteredSellerSource {
  page(
    context: CallContext,
    after: Id<'Seller'> | null,
    limit: number,
  ): Promise<RegisteredSellerPage>;
}

export const REGISTERED_SELLER_SOURCE = Symbol('REGISTERED_SELLER_SOURCE');
