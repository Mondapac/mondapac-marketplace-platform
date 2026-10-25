import 'server-only';
import { headers } from 'next/headers';
import { getLocale, getTranslations } from 'next-intl/server';
import { apiGet, apiGetBytes, type ApiRead } from './api.ts';
import { sessionGet } from './session.ts';
import { isProductId, productDetailOf, type ProductDetailBody } from './product-detail.ts';
import {
  flatFeeOf,
  publicStoreOf,
  publicStorePageOf,
  sellerResultsOf,
  shopOf,
  type PublicStore,
} from './real-sellers.ts';
import type { AssistantSetup } from '../assistant/assistant.ts';
import { categoriesOf, loadHome, type HomeContent } from './home-source.ts';
import { photoUrls } from './photo-source.ts';
import { loadShellContent } from './shell-source.ts';
import { storeProductsOf, storeProductsPath } from './store-products.ts';
import { SAMPLE_ACCOUNT } from './sample-account.ts';
import { SAMPLE_CART_SOURCE, SAMPLE_CHECKOUT, sampleQuotes } from './sample-cart.ts';
import { SAMPLE_DELIVERY_LOCATOR } from './sample-delivery.ts';
import { sampleProduct } from './sample-product.ts';
import { sampleSeller } from './sample-seller.ts';
import { SAMPLE_SELLER_SIGN_UP } from './sample-seller-sign-up.ts';
import { cardSetup, storefrontApiConfig, storefrontHostFor } from './config.ts';
import { sellerSignInUrls } from './seller-sign-in.ts';
import { callSellerSignUp, type SellerSignUpCall } from './seller-sign-up-api.ts';
import { sampleSellers } from './sample-sellers.ts';
import { sampleClosedStore, sampleUnavailableProduct } from './sample-unavailable.ts';
import type {
  AccountSource,
  CartSource,
  CheckoutSource,
  ClosedStore,
  DeliveryAreaAnswer,
  DeliveryLocatorSource,
  DeliveryQuote,
  PayAnswer,
  PayRequest,
  Money,
  ProductDetail,
  QuoteAddress,
  SellerQuery,
  SellerResults,
  SellerShop,
  SellerSignUpAnswer,
  SellerSignUpSetup,
  StorefrontContent,
  StoreProducts,
  UnavailableProduct,
} from './types.ts';

/**
 * True while any read in this file returns sample data. It turns false only when every read here
 * calls the API. It is the indexing lock: search engines cannot be let in while it is true
 * (src/seo/indexing.ts).
 */
export const SAMPLE_DATA: boolean = true;

/**
 * The shell's content: delivery area, popular searches, the drawer categories and the sample
 * sellers. The categories and popular searches come from the approved navigation and the live
 * category tree when API_BASE_URL is set; the delivery area and sellers are sample data. See
 * ./shell-source.ts.
 */
export async function loadStorefrontContent(): Promise<StorefrontContent> {
  return loadShellContent();
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
  const [locale, t, photo] = await Promise.all([
    getLocale(),
    getTranslations('seller'),
    photoUrls(),
  ]);
  return productDetailOf(
    read.body,
    locale,
    { minimum: (amount) => t('minimum', { amount }), noMinimum: t('no-minimum') },
    photo,
  );
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
    card: cardSetup(),
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
 * Each seller's delivery quote for an address (Scheduled is the seller's flat fee; Express is the
 * courier's live price). SAMPLE: no courier is connected yet (delivery plan: Uber Direct, Zoom2u
 * as the fallback), so every seller gets its sample price; the address is not used until then.
 */
export async function quoteDelivery(
  _address: QuoteAddress,
  sellerIds: readonly string[],
): Promise<Readonly<Record<string, DeliveryQuote>>> {
  return Promise.resolve(sampleQuotes(sellerIds));
}

/**
 * Pay: checks the order again (Express prices, stock) and then takes the payment, or answers what
 * changed with nothing charged. SAMPLE until the ordering API takes payments (the next package:
 * a manual-capture PaymentIntent from the card tile's confirmation token, refusing any brand but
 * Visa and Mastercard; the hosted Checkout Session for the Stripe tile). Until then a Stripe
 * confirmation token has nothing to go to and answers `failed`; the sample charges nothing.
 */
export async function takePayment(request: PayRequest): Promise<PayAnswer> {
  const source = SAMPLE_CART_SOURCE;
  const sellerIds = Object.keys(request.delivery);
  const quotes = await quoteDelivery(request.address, sellerIds);
  const changes = sellerIds.flatMap((id) => {
    const choice = request.delivery[id];
    const quote = Object.hasOwn(quotes, id) ? quotes[id] : undefined;
    if (choice?.speed !== 'express' || quote?.kind !== 'quote') return [];
    // No Express any more: the seller's Scheduled fee applies.
    const now =
      quote.express ??
      (Object.hasOwn(source.sellers, id) ? source.sellers[id]?.deliveryFee : undefined);
    if (!now) return [];
    if (now.amount === choice.fee.amount && now.currency === choice.fee.currency) return [];
    return [{ sellerId: id, was: choice.fee, now }];
  });
  // A seller the courier no longer reaches, or no answer: nothing is charged.
  if (sellerIds.some((id) => quotes[id]?.kind !== 'quote')) return { kind: 'failed' };
  if (changes.length > 0) return { kind: 'price-changed', changes, quotes };
  const known = (id: string) => Object.hasOwn(source.items, id);
  if (Object.keys(request.lines).some((id) => !known(id))) return { kind: 'failed' };
  const stock = Object.entries(request.lines).flatMap(([id, quantity]) => {
    const left = source.items[id]?.lowStock;
    return left !== undefined && quantity > left ? [{ itemId: id, was: quantity, now: left }] : [];
  });
  if (stock.length > 0) return { kind: 'stock-changed', changes: stock };
  if (request.method === 'stripe') return { kind: 'redirect', url: '/checkout/payment' };
  if (request.confirmationToken !== null) return { kind: 'failed' };
  return { kind: 'paid', reference: SAMPLE_CHECKOUT.orderReference };
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
 * minimum order, and `GET search/products?store=<slug>` gives one page of its products (24 cards)
 * with their photos; the other parts stay absent until their public reads exist. Otherwise sample
 * data. Any answer but 200 or 404 for the store throws, so the page shows its error state; a
 * failed products read does not: the Products tab says so and the rest of the page stays.
 */
export async function loadSeller(slug: string, page = 1): Promise<SellerShop | undefined> {
  // No sample or real store has any other slug; nothing else reaches the API path.
  if (slug.length > 50 || !STORE_SLUG.test(slug)) return undefined;
  const [answer, fee] = await Promise.all([
    apiGet<unknown>(`sellers/stores/${encodeURIComponent(slug)}`),
    apiGet<unknown>(`shipping/stores/${encodeURIComponent(slug)}/flat-fee`),
  ]);
  if (answer.kind === 'off') return sampleSeller(slug);
  if (answer.kind === 'failed') {
    // Only the store module's own answer means "no such store"; a bare 404 is a missing route.
    if (answer.status === 404 && answer.code === 'sellers.store-not-found') return undefined;
    throw new SellerReadFailed();
  }
  const store = publicStoreOf(answer.body);
  const [areaName, storeProducts] = await Promise.all([
    areaNames(),
    loadStoreProducts(store.slug, page),
  ]);
  return {
    ...shopOf(store, areaName(store.serviceAreaCode)),
    storeProducts,
    ...deliveryFeeOf(slug, fee),
  };
}

/**
 * The store's flat delivery fee as a part of the page, or nothing. The page never fails for it: a
 * store with no fee set (the module's own 404), a failed read and an answer of the wrong shape all
 * leave the fee line out, so no fee is ever guessed. Only a shape fault is logged here (the read
 * itself logs its own refusal).
 */
function deliveryFeeOf(slug: string, read: ApiRead<unknown>): { readonly deliveryFee?: Money } {
  if (read.kind !== 'ok') return {};
  try {
    return { deliveryFee: flatFeeOf(read.body) };
  } catch {
    console.log(JSON.stringify({ msg: 'storefront.seller-flat-fee-unusable', slug }));
    return {};
  }
}

/** One page of a store's products; any failure is `failed`, never an exception. */
async function loadStoreProducts(slug: string, page: number): Promise<StoreProducts> {
  const [answer, tree, photo] = await Promise.all([
    apiGet<unknown>(storeProductsPath(slug, page)),
    // Only for the illustration of a card without a photo; a failed tree gives plain cards.
    apiGet<unknown>('catalog/categories'),
    photoUrls(),
  ]);
  if (answer.kind !== 'ok') return { kind: 'failed', page };
  const slugs = categoriesOf(tree.kind === 'ok' ? tree.body : null).slugs;
  return storeProductsOf(answer.body, page, slugs, photo);
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
 * The sell page's Market values: password rule, area, business identifier, seller sign-in page.
 * With API_BASE_URL set, the sign-in page is the request Market's from SELLER_SIGN_IN_URLS; the
 * rest stays sample until the storefront reads the Market config.
 */
export async function loadSellerSignUp(): Promise<SellerSignUpSetup> {
  const config = storefrontApiConfig();
  if (config === null) return SAMPLE_SELLER_SIGN_UP;
  const host = storefrontHostFor(config, (await headers()).get('host'));
  const sellerSignInUrl = host && sellerSignInUrls(config)[host.marketId];
  return sellerSignInUrl ? { ...SAMPLE_SELLER_SIGN_UP, sellerSignInUrl } : SAMPLE_SELLER_SIGN_UP;
}

/**
 * The call's inputs for this request, or null (logged) while API_BASE_URL is empty, without a
 * signing key (the API refuses the storefront without a proved address) or on an unlisted host.
 */
async function sellerSignUpCall(route: string): Promise<SellerSignUpCall | null> {
  const off = (reason: string): null => {
    console.log(JSON.stringify({ msg: 'storefront.seller-sign-up.off', route, reason }));
    return null;
  };
  const config = storefrontApiConfig();
  if (config === null) return off('not-connected');
  const { apiBaseUrl, clientAddressKey } = config;
  if (clientAddressKey === null) return off('no-key');
  const incoming = await headers();
  const host = storefrontHostFor(config, incoming.get('host'));
  if (host === undefined) return off('unknown-host');
  return { apiBaseUrl, clientAddressKey, host, incoming };
}

/**
 * Creates a seller account (identity `POST identity/seller/sign-up`, PR #443). The answer never
 * says whether the address has an account. Not connected or an unknown host: failed, logged
 * without the address. In a Market whose storefront origin is not set yet (AU until D2) the API
 * refuses, so the page answers failed.
 */
export async function submitSellerSignUp(input: {
  readonly name: string;
  readonly email: string;
  readonly password: string;
}): Promise<SellerSignUpAnswer> {
  const call = await sellerSignUpCall('sign-up');
  if (call === null) return { kind: 'failed' };
  return callSellerSignUp(
    call,
    'sign-up',
    { displayName: input.name, email: input.email, password: input.password },
    { typed: input.password, maxLength: SAMPLE_SELLER_SIGN_UP.passwordMaxLength },
  );
}

/**
 * "Send it again" (identity `POST identity/seller/verification-email`): the same answer for every
 * address, as {@link submitSellerSignUp}.
 */
export async function resendSellerVerification(email: string): Promise<SellerSignUpAnswer> {
  const call = await sellerSignUpCall('verification-email');
  if (call === null) return { kind: 'failed' };
  return callSellerSignUp(call, 'verification-email', { email });
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

/** A store picture (logo or banner) as the buyer site's image route serves it. */
export type StoreImageRead =
  /** No store or no such image, or API_BASE_URL is empty (the sample stores have no picture). */
  | { readonly kind: 'none' }
  | { readonly kind: 'ok'; readonly bytes: Uint8Array }
  | { readonly kind: 'unavailable' };

const IMAGE_ID_PATH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * One size of a store's logo or banner, from `sellers/stores/:slug/images/:id/:size`. Only the
 * API's own "image not found" answer means there is no such picture; any other fault is
 * `unavailable`, so a cache never keeps a missing picture for an outage. Anything that is not a
 * JPEG is refused: the route serves only what the API wrote.
 */
export async function loadStoreImage(
  slug: string,
  imageId: string,
  size: string,
): Promise<StoreImageRead> {
  if (slug.length > 50 || !STORE_SLUG.test(slug)) return { kind: 'none' };
  if (!IMAGE_ID_PATH.test(imageId) || (size !== 'small' && size !== 'large')) {
    return { kind: 'none' };
  }
  const answer = await apiGetBytes(
    `sellers/stores/${encodeURIComponent(slug)}/images/${imageId}/${size}`,
  );
  if (answer.kind === 'off') return { kind: 'none' };
  if (answer.kind === 'failed') {
    return answer.status === 404 && answer.code === 'image.not-found'
      ? { kind: 'none' }
      : { kind: 'unavailable' };
  }
  const type = answer.body.contentType.split(';', 1)[0]?.trim().toLowerCase();
  return type === 'image/jpeg' && answer.body.bytes.length > 0
    ? { kind: 'ok', bytes: answer.body.bytes }
    : { kind: 'unavailable' };
}

/** Who is shopping, as the API sees this browser's cookies (storefront session design 2). */
export type BuyerSession =
  /** The API is off: the sample log-in stays. */
  | { readonly kind: 'off' }
  /** No session, or it ended. `cartLines` is null when the cart could not be read. */
  | { readonly kind: 'guest'; readonly cartLines: number | null }
  | {
      readonly kind: 'signed-in';
      readonly email: string;
      /** Sent as `x-csrf-token` on every write through the relay (app/api/[...path]). */
      readonly csrfToken: string;
      readonly cartLines: number | null;
    };

/**
 * The buyer's session and the number of lines in their cart (the account's or the guest's). Reads
 * only; a renewed or cleared cookie reaches the browser through the relay, never from a page.
 */
export async function loadBuyerSession(): Promise<BuyerSession> {
  const [session, cart] = await Promise.all([
    sessionGet<{ email: string; csrfToken: string }>('identity/customer/session'),
    sessionGet<{ lineCount: number }>('cart'),
  ]);
  if (session.kind === 'off') return { kind: 'off' };
  const cartLines = cart.kind === 'ok' ? cart.body.lineCount : null;
  if (session.kind !== 'ok') return { kind: 'guest', cartLines };
  return {
    kind: 'signed-in',
    email: session.body.email,
    csrfToken: session.body.csrfToken,
    cartLines,
  };
}
