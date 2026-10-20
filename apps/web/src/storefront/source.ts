import 'server-only';
import { getLocale, getTranslations } from 'next-intl/server';
import { apiGet, type ApiRead } from './api.ts';
import { storefrontApiConfig } from './config.ts';
import { isProductId, productDetailOf, type ProductDetailBody } from './product-detail.ts';
import type { AssistantSetup } from '../assistant/assistant.ts';
import { loadHome, type HomeContent } from './home-source.ts';
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
  DeliveryAreaAnswer,
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
 * The shell's content: delivery area, popular searches, the rail and drawer categories and the
 * sample sellers. Sample data; the shell moves to the navigation and category reads in its own
 * package.
 */
export async function loadStorefrontContent(): Promise<StorefrontContent> {
  return Promise.resolve(SAMPLE_CONTENT);
}

/**
 * The home page middle: the published home layout, the live category tree and the product
 * shelves when API_BASE_URL is set, with sample data where they answer nothing (unless
 * STOREFRONT_SAMPLE_DATA is off). Sample only without the URL. See ./home-source.ts.
 */
export async function loadHomeContent(): Promise<HomeContent> {
  return loadHome();
}

/**
 * The product page's read: the product, its sellable offers and similar products, or undefined
 * when there is no such product. With the API on it asks `search/product-detail/:id` (a path id
 * that is not a product id is no product); with it off, the sample. An outage throws, so the
 * page shows the error page rather than "not found".
 */
export async function loadProduct(id: string): Promise<ProductDetail | undefined> {
  // Only the sample has paths that are not product ids; with the API on they are no product.
  if (!isProductId(id)) return storefrontApiConfig() === null ? sampleProduct(id) : undefined;
  const read = await apiGet<ProductDetailBody>(
    `search/product-detail/${encodeURIComponent(id.toLowerCase())}`,
  );
  if (read.kind === 'off') return sampleProduct(id);
  if (read.kind === 'failed') {
    if (read.status === 404) return undefined;
    throw new Error('product detail unavailable');
  }
  const [locale, t] = await Promise.all([getLocale(), getTranslations('seller')]);
  return productDetailOf(read.body, locale, {
    minimum: (amount) => t('minimum', { amount }),
    noMinimum: t('no-minimum'),
  });
}

/**
 * The cart's line details and each seller's delivery terms. Sample data until the cart read
 * returns them (handoffs/cart-checkout.md, PR 2).
 */
export async function loadCartSource(): Promise<CartSource> {
  return Promise.resolve(SAMPLE_CART_SOURCE);
}

/**
 * The checkout's customer, address book and service area. Sample data until the buyer's session
 * reaches the API; with API_BASE_URL set, a new address's postcode is checked by the API.
 */
export async function loadCheckout(): Promise<CheckoutSource> {
  return Promise.resolve({
    ...SAMPLE_CHECKOUT,
    areaCheck: storefrontApiConfig() === null ? 'sample' : 'api',
  });
}

/** What the API's postcode rule accepts (shipping `delivery-area`): printable ASCII, 1 to 16. */
const POSTCODE = /^[\x20-\x7e]{1,16}$/u;

/** The answer of a `shipping/delivery-area` read; anything but a yes or a no is `failed`. */
export function deliveryAreaAnswer(
  read: ApiRead<{ readonly delivers?: unknown }>,
): DeliveryAreaAnswer {
  if (read.kind !== 'ok') return { kind: read.kind };
  const delivers = read.body.delivers;
  if (typeof delivers !== 'boolean') return { kind: 'failed' };
  return { kind: delivers ? 'in' : 'out' };
}

/**
 * Whether the Market delivers to a postcode (shipping `GET delivery-area`, anonymous). Checkout
 * asks the same before it takes an order, so this only spares the buyer a refused order.
 */
export async function checkDeliveryArea(postcode: string): Promise<DeliveryAreaAnswer> {
  const value = postcode.trim();
  if (!POSTCODE.test(value)) return { kind: 'out' };
  return deliveryAreaAnswer(
    await apiGet<{ readonly delivers?: unknown }>(
      `shipping/delivery-area?postcode=${encodeURIComponent(value)}`,
    ),
  );
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
 * similar ones), or undefined for an id that never existed (the 404 page). Sample data only: the
 * product detail read answers the same 404 for both (no oracle on hidden products), so with the
 * API on every miss is the 404 page until a read tells removed products apart.
 */
export async function loadUnavailableProduct(id: string): Promise<UnavailableProduct | undefined> {
  return Promise.resolve(storefrontApiConfig() === null ? sampleUnavailableProduct(id) : undefined);
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
