import 'server-only';
import { SAMPLE_CONTENT } from './sample-home.ts';
import { sampleProduct } from './sample-product.ts';
import type { ProductDetail, StorefrontContent } from './types.ts';

/**
 * The storefront's one read of the home content. Sample data for now; it calls the
 * pages-and-content and catalog APIs once PR #401 and storefront package 2 are on main.
 */
export async function loadStorefrontContent(): Promise<StorefrontContent> {
  return Promise.resolve(SAMPLE_CONTENT);
}

/**
 * The product page's read: the product, its sellable offers and similar products, or undefined
 * when there is no such product. Sample data until the backend has the product detail read.
 */
export async function loadProduct(id: string): Promise<ProductDetail | undefined> {
  return Promise.resolve(sampleProduct(id));
}
