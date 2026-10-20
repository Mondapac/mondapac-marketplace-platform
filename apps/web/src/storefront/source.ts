import 'server-only';
import { SAMPLE_ACCOUNT } from './sample-account.ts';
import { SAMPLE_CART_SOURCE, SAMPLE_CHECKOUT } from './sample-cart.ts';
import { SAMPLE_CONTENT } from './sample-home.ts';
import { sampleProduct } from './sample-product.ts';
import { sampleSeller } from './sample-seller.ts';
import { SAMPLE_SELLER_SIGN_UP } from './sample-seller-sign-up.ts';
import { sampleSellers } from './sample-sellers.ts';
import type {
  AccountSource,
  CartSource,
  CheckoutSource,
  ProductDetail,
  SellerQuery,
  SellerResults,
  SellerShop,
  SellerSignUpAnswer,
  SellerSignUpSetup,
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

/**
 * The sellers page's read: the matching stores, their total, the filter counts and where the
 * buyer's location stands. Sample data until the backend has a seller list read.
 */
export async function loadSellers(query: SellerQuery): Promise<SellerResults> {
  return Promise.resolve(sampleSellers(query));
}

/** The sell page's Market values: password rule, area, business identifier, seller sign-in page. */
export async function loadSellerSignUp(): Promise<SellerSignUpSetup> {
  return Promise.resolve(SAMPLE_SELLER_SIGN_UP);
}

/**
 * Creates a seller account (identity `POST identity/seller/sign-up`). Sample: every valid form is
 * accepted and no mail goes, until the storefront may reach the seller sign-up route (the API
 * takes seller requests only from the seller panel's origin; open decision in
 * handoffs/seller-signup-done.md). The answer never says whether the address has an account.
 */
export async function submitSellerSignUp(input: {
  readonly name: string;
  readonly email: string;
  readonly password: string;
}): Promise<SellerSignUpAnswer> {
  void input;
  return Promise.resolve({ kind: 'accepted' });
}

/**
 * "Send it again" (identity `POST identity/seller/verification-email`): the same answer for every
 * address. Sample until wired, as {@link submitSellerSignUp}.
 */
export async function resendSellerVerification(email: string): Promise<SellerSignUpAnswer> {
  void email;
  return Promise.resolve({ kind: 'accepted' });
}
