import type { ProductTypeHandler } from '../../domain/product-type-handler';

/** The registered handler of a product type (the `catalog.product-type` point), or undefined. */
export type ProductTypeLookup = (typeCode: string) => ProductTypeHandler | undefined;

export const PRODUCT_TYPE_LOOKUP = Symbol('PRODUCT_TYPE_LOOKUP');
