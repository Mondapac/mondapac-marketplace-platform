import 'server-only';
import { SAMPLE_CART_SOURCE, SAMPLE_CHECKOUT } from './sample-cart.ts';
import { SAMPLE_CONTENT } from './sample-home.ts';
import { sampleProduct } from './sample-product.ts';
import type { CartSource, CheckoutSource, ProductDetail, StorefrontContent } from './types.ts';

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

/**
 * The cart's line details and each seller's delivery terms. Sample data until the cart read
 * returns them (handoffs/cart-checkout.md, PR 2).
 */
export async function loadCartSource(): Promise<CartSource> {
  return Promise.resolve(SAMPLE_CART_SOURCE);
}

/** The checkout's customer, address book and service area. Sample data until checkout is wired. */
export async function loadCheckout(): Promise<CheckoutSource> {
  return Promise.resolve(SAMPLE_CHECKOUT);
}
