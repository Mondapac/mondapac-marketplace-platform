import 'server-only';
import { SAMPLE_ACCOUNT } from './sample-account.ts';
import { SAMPLE_CART_SOURCE, SAMPLE_CHECKOUT } from './sample-cart.ts';
import { SAMPLE_DELIVERY_LOCATOR } from './sample-delivery.ts';
import { SAMPLE_CONTENT } from './sample-home.ts';
import { sampleProduct } from './sample-product.ts';
import { sampleSeller } from './sample-seller.ts';
import type {
  AccountSource,
  CartSource,
  CheckoutSource,
  DeliveryLocatorSource,
  ProductDetail,
  SellerShop,
  StorefrontContent,
} from './types.ts';

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

/**
 * The Deliver to modal's service area and, until the map and address-lookup provider is chosen,
 * the sample places of its stubbed lookup (handoffs/deliver-to-modal.md).
 */
export async function loadDeliveryLocator(): Promise<DeliveryLocatorSource> {
  return Promise.resolve(SAMPLE_DELIVERY_LOCATOR);
}

/**
 * The seller page's read: profile, terms, certificates and products, or undefined when there is
 * no such seller. Sample data until the backend has the seller public read.
 */
export async function loadSeller(slug: string): Promise<SellerShop | undefined> {
  return Promise.resolve(sampleSeller(slug));
}

/**
 * The signed-in buyer's account: profile, orders, address book, saved lists and email choices.
 * Sample data until the account backend (orders read, profile, password, saved lists) exists.
 */
export async function loadAccount(): Promise<AccountSource> {
  return Promise.resolve(SAMPLE_ACCOUNT);
}
