import type { CallContext, Id } from '@mondapac/shared-kernel';

/** The product types a seller may sell (SEL-12): every type, or the listed codes. */
export type AllowedProductTypes = 'all' | ReadonlySet<string>;

/**
 * `allowedProductTypesOf` of sellers (catalog design 9.4). `null` is an error: the caller refuses
 * (fail closed, ADR-0031), it never reads an error as "allowed".
 */
export interface AllowedProductTypesReader {
  allowedFor(context: CallContext, sellerId: Id<'Seller'>): Promise<AllowedProductTypes | null>;
}

export const ALLOWED_PRODUCT_TYPES_READER = Symbol('ALLOWED_PRODUCT_TYPES_READER');
