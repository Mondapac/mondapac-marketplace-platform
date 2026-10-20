import 'server-only';
import type { AssistantSetup } from '../assistant/assistant.ts';
import { storefrontApiConfig } from './config.ts';
import { SAMPLE_ACCOUNT } from './sample-account.ts';
import { SAMPLE_CART_SOURCE, SAMPLE_CHECKOUT } from './sample-cart.ts';
import { SAMPLE_DELIVERY_LOCATOR } from './sample-delivery.ts';
import { SAMPLE_CONTENT } from './sample-home.ts';
import { sampleProduct } from './sample-product.ts';
import { sampleSeller } from './sample-seller.ts';
import { SAMPLE_SELLER_SIGN_UP } from './sample-seller-sign-up.ts';
import { sampleSellers } from './sample-sellers.ts';
import { sampleClosedStore, sampleUnavailableProduct } from './sample-unavailable.ts';
import type {
  AccountSource,
  CartSource,
  CheckoutSource,
  ClosedStore,
  DeliveryLocatorSource,
  ProductDetail,
  SellerQuery,
  SellerResults,
  SellerShop,
  SellerSignUpAnswer,
  SellerSignUpSetup,
  StorefrontContent,
  UnavailableProduct,
} from './types.ts';

/**
 * True while any read in this file returns sample data. It turns false only when every read here
 * calls the API. It is the indexing lock: search engines cannot be let in while it is true
 * (src/seo/indexing.ts).
 */
export const SAMPLE_DATA: boolean = true;

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
 * Orders, saved lists and email choices are sample data until their backends exist; the profile,
 * session and address book come from the API in live mode (see `live`).
 */
export async function loadAccount(): Promise<AccountSource> {
  return Promise.resolve({ ...SAMPLE_ACCOUNT, live: storefrontIsLive() });
}

/**
 * Whether the storefront talks to the API (`API_BASE_URL` is set). The account pages and the
 * shell's sign-in then use the customer routes through the same-origin relay; otherwise they run
 * on sample data.
 */
export function storefrontIsLive(): boolean {
  return storefrontApiConfig() !== null;
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

/**
 * A product id the product read did not find: a removed product (its page says so and shows
 * similar ones), or undefined for an id that never existed (the 404 page). Sample data until the
 * product detail read tells them apart.
 */
export async function loadUnavailableProduct(id: string): Promise<UnavailableProduct | undefined> {
  return Promise.resolve(sampleUnavailableProduct(id));
}

/**
 * A seller slug the seller read did not find: a store that is not taking orders (paused,
 * suspended or not live; the reason never reaches the buyer), or undefined for an unknown slug.
 * Sample data until the seller public read tells them apart.
 */
export async function loadClosedStore(slug: string): Promise<ClosedStore | undefined> {
  return Promise.resolve(sampleClosedStore(slug));
}

/**
 * Whether the buyer assistant shows, and what the widget needs: null while it is off. Always null
 * for now: the assistant ships switched off in every Market, and the storefront does not call the
 * API yet. Once it does, this asks `GET /assistant/storefront` and adds the conversation route,
 * the Market's support address and retention, and the session's CSRF token.
 */
export async function loadAssistant(): Promise<AssistantSetup | null> {
  return Promise.resolve(null);
}
