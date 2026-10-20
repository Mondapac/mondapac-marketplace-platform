import 'server-only';
import { getTranslations } from 'next-intl/server';
import { apiGet } from './api.ts';
import {
  publicStoreOf,
  publicStorePageOf,
  sellerResultsOf,
  shopOf,
  type PublicStore,
} from './real-sellers.ts';
import type { AssistantSetup } from '../assistant/assistant.ts';
import { SAMPLE_ACCOUNT } from './sample-account.ts';
import { SAMPLE_CART_SOURCE, SAMPLE_CHECKOUT } from './sample-cart.ts';
import { SAMPLE_DELIVERY_LOCATOR } from './sample-delivery.ts';
import { SAMPLE_CONTENT } from './sample-home.ts';
import { sampleProduct } from './sample-product.ts';
import { sampleSeller } from './sample-seller.ts';
import { SAMPLE_SELLER_SIGN_UP } from './sample-seller-sign-up.ts';
import { sampleSellers } from './sample-sellers.ts';
import type {
  AccountSource,
  CartSource,
  CheckoutSource,
  DeliveryLocatorSource,
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
 * The Deliver to modal's service area and, until the map and address-lookup provider is chosen,
 * the sample places of its stubbed lookup (handoffs/deliver-to-modal.md).
 */
export async function loadDeliveryLocator(): Promise<DeliveryLocatorSource> {
  return Promise.resolve(SAMPLE_DELIVERY_LOCATOR);
}

/** The display name of a ServiceArea code ("greater-brisbane"); the code itself when unnamed. */
async function areaNames(): Promise<(code: string) => string> {
  const t = await getTranslations('areas');
  return (code) => (t.has(code) ? t(code) : code);
}

/** The API answered something other than the expected status and shape. */
class SellerReadFailed extends Error {
  constructor() {
    super('the store read failed');
  }
}

const STORE_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * The seller page's read: profile, terms, certificates and products, or undefined when there is
 * no such seller. With the API configured, `GET sellers/stores/:slug` gives name, area, year and
 * minimum order; the other parts stay absent until their public reads exist. Otherwise sample
 * data. Any answer but 200 or 404 throws, so the page shows its error state.
 */
export async function loadSeller(slug: string): Promise<SellerShop | undefined> {
  // No sample or real store has any other slug; nothing else reaches the API path.
  if (slug.length > 50 || !STORE_SLUG.test(slug)) return undefined;
  const answer = await apiGet<unknown>(`sellers/stores/${encodeURIComponent(slug)}`);
  if (answer.kind === 'off') return sampleSeller(slug);
  if (answer.kind === 'failed') {
    // Only the store module's own answer means "no such store"; a bare 404 is a missing route.
    if (answer.status === 404 && answer.code === 'sellers.store-not-found') return undefined;
    throw new SellerReadFailed();
  }
  const store = publicStoreOf(answer.body);
  return shopOf(store, (await areaNames())(store.serviceAreaCode));
}

/** The API's sort for the page's: popularity and distance are not known yet, so name. */
const API_SORT = { popular: 'name', nearest: 'name', name: 'name', newest: 'newest' } as const;
/** The API's largest page. */
const API_PAGE_SIZE = 48;
/** At most this many API reads for one page view, however far "Show more" went. */
const MAX_API_PAGES = 4;

const anyFilter = (query: SellerQuery): boolean => {
  const { filters } = query;
  return (
    filters.newSellers ||
    filters.sameDay ||
    filters.certifications.length > 0 ||
    filters.categories.length > 0 ||
    filters.minimums.length > 0 ||
    filters.distance !== undefined
  );
};

/**
 * The sellers page's read: the matching stores, their total, the filter counts and where the
 * buyer's location stands. With the API configured, `GET sellers/stores` in pages until `limit`
 * stores are read (no filters or facets yet; the location is unknown until deliver-to is wired).
 * Otherwise sample data.
 */
export async function loadSellers(query: SellerQuery): Promise<SellerResults> {
  // The API cannot filter yet and the page offers no filter (no facets). A filter left in a
  // shared URL matches nothing rather than appearing to hold for stores nobody checked.
  if (anyFilter(query)) {
    const answer = await apiGet<unknown>(`sellers/stores?pageSize=1`);
    if (answer.kind === 'off') return sampleSellers(query);
    if (answer.kind === 'failed') throw new SellerReadFailed();
    const { total } = publicStorePageOf(answer.body);
    return { ...sellerResultsOf([], total, await areaNames()), total: 0 };
  }
  const stores: PublicStore[] = [];
  let total = 0;
  for (let page = 1; stores.length < query.limit && page <= MAX_API_PAGES; page += 1) {
    const params = new URLSearchParams({
      sort: API_SORT[query.sort],
      page: String(page),
      pageSize: String(API_PAGE_SIZE),
    });
    const answer = await apiGet<unknown>(`sellers/stores?${params.toString()}`);
    if (answer.kind === 'off') return sampleSellers(query);
    if (answer.kind === 'failed') throw new SellerReadFailed();
    const read = publicStorePageOf(answer.body);
    total = read.total;
    stores.push(...read.items);
    if (read.items.length < API_PAGE_SIZE) break;
  }
  return sellerResultsOf(stores.slice(0, query.limit), total, await areaNames());
}

/**
 * The signed-in buyer's account: profile, orders, address book, saved lists and email choices.
 * Sample data until the account backend (orders read, profile, password, saved lists) exists.
 */
export async function loadAccount(): Promise<AccountSource> {
  return Promise.resolve(SAMPLE_ACCOUNT);
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
 * Whether the buyer assistant shows, and what the widget needs: null while it is off. Always null
 * for now: the assistant ships switched off in every Market, and the storefront does not call the
 * API yet. Once it does, this asks `GET /assistant/storefront` and adds the conversation route,
 * the Market's support address and retention, and the session's CSRF token.
 */
export async function loadAssistant(): Promise<AssistantSetup | null> {
  return Promise.resolve(null);
}
