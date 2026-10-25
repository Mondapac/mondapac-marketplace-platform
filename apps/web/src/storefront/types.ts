import type { SellerFilters, SellerSort } from '../sellers/sellers-state.ts';

// The storefront's view of the backend contracts. Until PR #401 (pages and content) and
// storefront package 2 (best sellers, special prices, category tree) are on main, the home page
// reads these shapes from the sample source in ./sample-home.ts; only that file changes when the
// API is wired.

/** Integer minor units plus an ISO 4217 code (ADR-0007); never assume a currency. */
export interface Money {
  readonly amount: number;
  readonly currency: string;
}

/** The structured badge certification builds from evaluateClaim (CLAUDE.md, AI rule R1). */
export interface CertificationBadge {
  /** The certification type's code; the storefront picks the seal artwork by it. */
  readonly type: string;
  /** Accessible label of the seal, e.g. "Halal certified". */
  readonly label: string;
  // The fields below come from the live badge of the product page's read; the samples have none.
  /** Whose certificate it is: the seller's own, or the product manufacturer's. */
  readonly basis?: 'SELLER' | 'MANUFACTURER';
  /** True when this is the seller's own declaration, not an outside body's certificate. */
  readonly sellerClaim?: boolean;
  /** The issuing body's name, when there is one. */
  readonly issuer?: string;
  /** ISO calendar date (`YYYY-MM-DD`) the certificate is valid until. */
  readonly validUntil?: string;
  /** True when the platform confirmed the certificate with its issuer. */
  readonly verifiedWithIssuer?: boolean;
}

export interface ProductCard {
  readonly id: string;
  readonly name: string;
  /** Empty when the read does not carry it (the shelf routes give only a seller id). */
  readonly sellerName: string;
  /** Category code, used for the fallback illustration when there is no photo. */
  readonly category: string;
  readonly price: Money;
  /** The regular price when a special price applies. */
  readonly wasPrice?: Money;
  readonly certifications: readonly CertificationBadge[];
  /** Units left when stock is low; absent when stock is not low. */
  readonly lowStock?: number;
  readonly imageUrl?: string;
}

/**
 * A product card of a home shelf. The price is absent when the shelf read does not carry it (the
 * best-sellers route gives ids and text only): the card then shows no price and no add button.
 */
export type ShelfCard = Omit<ProductCard, 'price'> & { readonly price?: Money };

export interface SellerSummary {
  readonly id: string;
  readonly name: string;
  readonly initials: string;
  readonly deliveryWindow: string;
  readonly minimumOrder: string;
  /** Key of a sample logo; real sellers' logos arrive with media. */
  readonly logo?: string;
}

/**
 * A "Sellers near you" tile. The public store list has no delivery window yet, and its minimum
 * order is absent when it cannot be told, so both lines are optional here.
 */
export type HomeSeller = Omit<SellerSummary, 'deliveryWindow' | 'minimumOrder'> & {
  readonly deliveryWindow?: string;
  readonly minimumOrder?: string;
};

export interface Category {
  readonly code: string;
  readonly name: string;
  readonly shortName: string;
  readonly children: readonly { readonly code: string; readonly name: string }[];
}

export interface PromoBanner {
  readonly id: string;
  readonly variant: 'primary' | 'secondary';
  readonly title: string;
  readonly body: string;
  /** Absent when the layout gives no link or no button label. */
  readonly action?: { readonly label: string; readonly href: string };
  readonly images: readonly string[];
}

/**
 * One slide of a slider position: plain text over an optional image, with one internal link that
 * makes the whole slide clickable. Built only by `slideSetOf` / `legacySlideOf`
 * (src/storefront/slides.ts), which check every field.
 */
export interface HeroSlide {
  readonly id: string;
  readonly title: string;
  readonly body?: string;
  /** The button label; only with `href`. */
  readonly ctaLabel?: string;
  /** A site path (`/offers`), never a URL. */
  readonly href?: string;
  /** A site-relative placeholder path or a URL on our own media origin. */
  readonly image?: { readonly src: string; readonly alt: string; readonly decorative: boolean };
  /** Where the text sits along the line of text: start, centre or end (flips in right-to-left). */
  readonly placement: 'start' | 'center' | 'end';
  /** `light`: light text on a dark scrim; `dark`: dark text on a light scrim. */
  readonly tone: 'light' | 'dark';
  readonly sponsored: boolean;
}

/** The slides of one position, as the API answered them and the buyer app re-checked them. */
export interface SlideSet {
  readonly position: string;
  /** The position allows autoplay and the API asked for it. */
  readonly autoplay: boolean;
  readonly slides: readonly HeroSlide[];
}

/** One section of the admin-editable middle of the home page (handoffs/storefront.md). */
export type HomeSection =
  | { readonly kind: 'hero'; readonly set: SlideSet }
  | { readonly kind: 'promos'; readonly banners: readonly PromoBanner[] }
  | { readonly kind: 'categories' }
  | { readonly kind: 'sellers'; readonly title: string; readonly href: string }
  | {
      readonly kind: 'products';
      readonly title: string;
      readonly href: string;
      readonly products: readonly ShelfCard[];
    };

export interface DeliveryArea {
  readonly label: string;
}

export interface StorefrontContent {
  readonly delivery: DeliveryArea;
  readonly popularSearches: readonly string[];
  readonly categories: readonly Category[];
  readonly sellers: readonly SellerSummary[];
  readonly home: readonly HomeSection[];
}

/** The optional promotion banner above a product listing (an admin-managed content slot). */
export interface ListingBanner {
  readonly title: string;
  readonly body: string;
  readonly action: { readonly label: string; readonly href: string };
  readonly imageUrl?: string;
}

/**
 * A band of the Price filter. `below` and `above` are exclusive; `from` and `to` inclusive. A
 * band has `below`, `above`, or both `from` and `to`.
 */
export interface PriceBand {
  readonly id: string;
  readonly below?: Money;
  readonly from?: Money;
  readonly to?: Money;
  readonly above?: Money;
}

/** What a buyer sees of a seller before ordering: the seller card on the product page. */
export interface SellerProfile {
  readonly id: string;
  readonly name: string;
  /** Key of a sample logo; absent for a seller without a profile logo (the default tile shows). */
  readonly logo?: string;
  /** Absent until the seller public read has it (real data); the card then leaves the line out. */
  readonly city?: string;
  readonly sellingSince?: number;
  /** Certificates the platform checked, named for the card line ("Halal certificate checked"). */
  readonly certificates: readonly { readonly type: string; readonly name: string }[];
  /**
   * Ratings from orders and reviews. Sample data until those exist; v1 may show the static
   * facts only (open question to john), so the card works without them.
   */
  readonly ratings?: {
    /** Whole percent. */
    readonly satisfaction: number;
    readonly count: number;
    readonly onTime: number;
    readonly asDescribed: number;
  };
}

/** One seller's offer of a product; `id` is the cart line key. */
export interface ProductOffer {
  readonly id: string;
  /** The priced Variant, for the cart (real data); sample offers have none. */
  readonly variantId?: string;
  readonly seller: SellerProfile;
  readonly price: Money;
  readonly wasPrice?: Money;
  /** Badges built by certification from evaluateClaim for this offer. */
  readonly certifications: readonly CertificationBadge[];
  readonly lowStock?: number;
  /** Absent until the backend has delivery promises (real data); the page leaves it out. */
  readonly deliveryWindow?: string;
  /** Absent when the seller's minimum order cannot be told; the page leaves it out. */
  readonly minimumOrder?: string;
}

export interface ProductSpecification {
  readonly label: string;
  readonly value: string;
}

/** The product page: the product, its offers (the featured one first) and similar products. */
export interface ProductDetail {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly description: string;
  readonly specifications: readonly ProductSpecification[];
  readonly photos: readonly string[];
  /** Small versions of `photos`, same order and length, for the thumbnail strip. */
  readonly photoThumbs?: readonly string[];
  /** Never empty: a product without a sellable offer is not shown. */
  readonly offers: readonly [ProductOffer, ...ProductOffer[]];
  readonly similar: readonly ProductCard[];
}

/** What the cart shows of one line's offer (the cart read returns it with each line). */
export interface CartItem {
  readonly name: string;
  readonly sellerId: string;
  /** Category code, for the fallback illustration when there is no photo. */
  readonly category: string;
  readonly price: Money;
  readonly lowStock?: number;
  readonly imageUrl?: string;
  /** The price when the buyer added the line, when it has changed since (the price-changed flag). */
  readonly addedAt?: Money;
}

/** A seller's delivery terms as the cart and checkout show them. */
export interface SellerTerms {
  readonly id: string;
  readonly name: string;
  /** Key of a sample logo; absent for a seller without a profile logo (the default tile shows). */
  readonly logo?: string;
  /** Set by the seller; the buyer does not choose it. */
  readonly deliveryWindow: string;
  /** The seller's minimum order; absent when it has none. */
  readonly minimumOrder?: Money;
  /** The seller's flat delivery fee for one order (Scheduled delivery). */
  readonly deliveryFee: Money;
  /** Whether the seller takes Express orders now; absent: it does not offer Express. */
  readonly express?: ExpressTerms;
}

/**
 * Express delivery of one seller (within 2 hours once the seller has the order ready, booked by
 * the platform with a courier). The cut-off is evaluated by the backend in the seller's time zone
 * (ADR-0005); the storefront only shows it.
 */
export type ExpressTerms =
  | { readonly kind: 'offered' }
  | { readonly kind: 'not-offered' }
  /** Today's cut-off has passed: `cutoff` is the instant, `timeZone` the seller's IANA zone. */
  | { readonly kind: 'closed'; readonly cutoff: string; readonly timeZone: string };

/** How one seller's part is delivered; Scheduled (the seller's window) is the default. */
export type DeliverySpeed = 'scheduled' | 'express';

/** The address a delivery quote is asked for: a saved address, or a new address's postcode. */
export type QuoteAddress =
  | { readonly kind: 'saved'; readonly id: string }
  | { readonly kind: 'new'; readonly postcode: string };

/**
 * The courier's answer for one seller and one address: the live Express price (null when the
 * seller takes no Express order now), or that its couriers do not reach the address, or no answer.
 * Quotes are checked again when the buyer pays.
 */
export type DeliveryQuote =
  | { readonly kind: 'quote'; readonly express: Money | null }
  | { readonly kind: 'out-of-range' }
  | { readonly kind: 'failed' };

/**
 * How the cart shows the tax a GST-inclusive total holds ("Includes A$x GST"). A PLACEHOLDER
 * until the tax module gives the figure: whether tax applies to delivery fees, and tax-exclusive
 * prices, are not settled (tax adviser, 19 Oct 2026), so nothing here is a rule.
 */
export interface IncludedTaxPreview {
  /** Share of a tax-inclusive amount that is tax, as a fraction. */
  readonly share: { readonly numerator: number; readonly denominator: number };
  readonly includesDelivery: boolean;
}

/** A discount code applied to the cart: a share off the items, never off delivery. */
export interface AppliedDiscount {
  readonly code: string;
  readonly percentOff: number;
}

/** Everything the cart drawer and the cart page need beside the lines themselves. */
export interface CartSource {
  readonly items: Readonly<Record<string, CartItem>>;
  readonly sellers: Readonly<Record<string, SellerTerms>>;
  readonly tax: IncludedTaxPreview;
  /**
   * SAMPLE ONLY: the codes the sample accepts, by code. The backend's validate endpoint replaces
   * this list; who funds a discount and its GST treatment are not settled.
   */
  readonly sampleDiscounts: Readonly<Record<string, AppliedDiscount>>;
}

export interface SavedAddress {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  /** Street address and unit. */
  readonly street: string;
  /** The API's second line and courier note; kept so a save does not drop them (not on the form). */
  readonly line2: string | null;
  readonly suburb: string;
  readonly postcode: string;
  readonly phone: string;
  readonly deliveryNotes: string | null;
  readonly isDefault: boolean;
}

/** The signed-in customer (checkout, the account menu). */
export interface CheckoutCustomer {
  readonly firstName: string;
  readonly fullName: string;
  readonly email: string;
  readonly addresses: readonly SavedAddress[];
}

/** The area the platform delivers to; a new address outside it is refused at checkout. */
export interface ServiceArea {
  readonly name: string;
  /** The state or region every address in the area has (read-only on the form). */
  readonly region: string;
  /** The region's short form in a one-line address ("QLD"). */
  readonly regionCode: string;
  readonly postcodes: readonly { readonly from: string; readonly to: string }[];
}

export interface CheckoutSource {
  /** The account a sample log-in signs in to; the session gives it when checkout is wired. */
  readonly customer: CheckoutCustomer;
  readonly serviceArea: ServiceArea;
  /** Sample only: the order Pay creates gives its reference when checkout is wired. */
  readonly orderReference: string;
  /**
   * Sample only: the places the stubbed address search knows (suburbs and street addresses in the
   * service area). The address-lookup provider replaces this list.
   */
  readonly places: readonly CheckoutPlace[];
  /**
   * Who answers whether a new address's postcode is delivered to: `sample` checks
   * `serviceArea.postcodes` in the browser; `api` asks the API's delivery area (API_BASE_URL set).
   */
  readonly areaCheck: 'sample' | 'api';
}

/** A suburb (no street) or a street address the checkout's address search suggests. */
export interface CheckoutPlace {
  readonly id: string;
  /** The street part ("12 Example Street"); empty for a suburb. */
  readonly street: string;
  readonly suburb: string;
  /** The state or region as written in an address ("QLD"). */
  readonly regionCode: string;
  readonly postcode: string;
}

/** The API's answer for one postcode: `off` while the storefront reads sample data. */
export type DeliveryAreaAnswer =
  | { readonly kind: 'off' }
  | { readonly kind: 'in' }
  | { readonly kind: 'out' }
  | { readonly kind: 'failed' };

/** A point on the map (WGS 84 degrees). */
export interface GeoPoint {
  readonly lat: number;
  readonly lng: number;
}

/** An address or a suburb the address lookup knows. */
export interface Place {
  readonly id: string;
  /** The street part ("12 Example Street"); empty for a suburb. */
  readonly street: string;
  readonly suburb: string;
  /** The state or region as written in an address ("QLD"). */
  readonly region: string;
  readonly postcode: string;
  readonly point: GeoPoint;
}

/** The map's extent: the stubbed map draws this box. */
export interface MapBounds {
  readonly north: number;
  readonly south: number;
  readonly west: number;
  readonly east: number;
}

/**
 * What the Deliver to modal needs: the service area (ServiceArea config) and, while the map and
 * address-lookup provider is not chosen, the sample places its stubbed lookup knows.
 */
export interface DeliveryLocatorSource {
  readonly area: {
    readonly name: string;
    /** The region's short form in a one-line address ("QLD"). */
    readonly regionCode: string;
    readonly boundary: readonly GeoPoint[];
  };
  readonly bounds: MapBounds;
  /** Where the pin starts when the buyer has not chosen a place the lookup can find. */
  readonly start: Place;
  /** Sample only: the addresses the stubbed search finds. */
  readonly addresses: readonly Place[];
  /** Sample only: the suburbs the stubbed reverse lookup and the map labels use. */
  readonly suburbs: readonly Place[];
}

/**
 * A certificate the platform approved for a seller, as the seller page's Certificates tab shows it.
 * Contract of the seller read: it returns only certificates that are approved and in date today, so
 * the page shows each one as "Approved and in date" without its own date check (CERT-*).
 */
export interface SellerCertificate {
  /** The certification type's code (CERT-*); the label it allows comes from evaluateClaim only. */
  readonly type: string;
  /** Display name of the type, e.g. "Halal". */
  readonly name: string;
  readonly certifier: string;
  readonly number: string;
  /** ISO dates (YYYY-MM-DD). */
  readonly validUntil: string;
  readonly checkedOn: string;
}

/** A product on the seller page; `listedAt` (an ISO date) orders the Newest sort. */
export interface SellerProduct extends ProductCard {
  readonly listedAt: string;
}

/**
 * One page of the store's products from the API (`search/products?store=`): cards in name order.
 * No total is known (the API answers `hasMore`), so the tab shows no count.
 */
export type StoreProducts =
  | {
      readonly kind: 'ok';
      readonly items: readonly ShelfCard[];
      readonly page: number;
      readonly hasMore: boolean;
    }
  | { readonly kind: 'failed'; readonly page: number };

/**
 * The public seller page (`/s/<slug>`): profile, terms, certificates and products. Fields marked
 * "not known yet" are absent while the seller read has no source for them (the API answers name,
 * area, year and minimum order today): the page then leaves that part out, never shows "none".
 */
export interface SellerShop {
  /** The URL slug. */
  readonly id: string;
  readonly name: string;
  /** Key of a sample logo; absent for a seller without a profile logo (the default tile shows). */
  readonly logo?: string;
  /** The logo the store uploaded; it wins over `logo`. Absent: the default tile shows. */
  readonly logoImage?: StoreImage;
  /** The banner the store uploaded. Absent: the default banner shows. */
  readonly banner?: StoreImage;
  /** Suburb and city only, or the ServiceArea's name; the seller's address is never shown. */
  readonly location: string;
  readonly sellingSince: number;
  /** Not known yet when absent. */
  readonly about?: string;
  /** What the platform checked of the business, e.g. "ABN checked by Mondapac". Not known yet when absent. */
  readonly businessCheck?: string;
  /** Not known yet when absent. */
  readonly deliveryWindow?: string;
  /** Not known yet when absent. */
  readonly deliveryFee?: Money;
  /** Absent when the seller has no minimum order (unless `minimumUnknown`). */
  readonly minimumOrder?: Money;
  /** The minimum order cannot be told now: no minimum line is shown. */
  readonly minimumUnknown?: true;
  /** The area the seller delivers to. Not known yet when absent. */
  readonly deliversTo?: string;
  /** Not known yet when absent: the Certificates tab is left out, never "no certificates". */
  readonly certificates?: readonly SellerCertificate[];
  /** Absent for a new seller without ratings; shown only behind the seller-ratings feature. */
  readonly ratings?: {
    readonly satisfaction: number;
    readonly onTime: number;
    readonly asDescribed: number;
    readonly count: number;
  };
  /** The categories of its products, in display order. Not known yet when absent. */
  readonly categories?: readonly { readonly code: string; readonly name: string }[];
  /** In popularity order. Not known yet when absent: the Products tab is left out. */
  readonly products?: readonly SellerProduct[];
  /**
   * The store's products read from the API, one page. Used instead of `products` when the seller
   * read is real: the tab then pages through the cards and shows a failed read inside the tab.
   */
  readonly storeProducts?: StoreProducts;
}

/**
 * A store picture (logo or banner) the store published: where the buyer site serves it from and
 * its pixels, so the page can reserve the space. Absent when the store has none.
 */
export interface StoreImage {
  readonly src: string;
  readonly width: number;
  readonly height: number;
}

/** A seller page with every part known: what the sample data gives. */
export type CompleteSellerShop = SellerShop &
  Required<
    Pick<
      SellerShop,
      | 'about'
      | 'businessCheck'
      | 'deliveryWindow'
      | 'deliveryFee'
      | 'deliversTo'
      | 'certificates'
      | 'categories'
      | 'products'
    >
  >;

/** Where one seller's part of an order is. */
export type OrderPartStatus =
  'waiting' | 'confirmed' | 'out-for-delivery' | 'delivered' | 'cancelled';

/** The whole order's state, as the Orders filter groups it. */
export type OrderStatus = 'in-progress' | 'delivered' | 'cancelled';

/** One line of a placed order, with the name and price it had when it was ordered. */
export interface OrderLine {
  /** The offer bought; Buy again adds it to the cart when it is still sold. */
  readonly offerId: string;
  readonly name: string;
  readonly category: string;
  readonly quantity: number;
  readonly unitPrice: Money;
  readonly imageUrl?: string;
}

/** One seller's part of an order: each seller prepares and delivers its own part. */
export interface OrderPart {
  readonly sellerId: string;
  readonly sellerName: string;
  readonly status: OrderPartStatus;
  /** The delivery window promised, as the seller wrote it. */
  readonly deliveryWindow: string;
  /** The day the part was delivered (ISO date), once it is. */
  readonly deliveredOn?: string;
  readonly deliveryFee: Money;
  /** The buyer's note to this seller at checkout. */
  readonly note?: string;
  readonly lines: readonly OrderLine[];
}

/** A placed order as the buyer's account shows it. */
export interface AccountOrder {
  readonly reference: string;
  /** The day it was placed (ISO date). */
  readonly placedOn: string;
  readonly status: OrderStatus;
  /** The delivery address, as one line with its label. */
  readonly deliveredTo: string;
  readonly parts: readonly [OrderPart, ...OrderPart[]];
  /** The GST included in the total, as the order's tax record gives it. */
  readonly includedTax: Money;
}

/** A list the buyer named (Saved lists), holding offer ids. */
export interface NamedList {
  readonly id: string;
  readonly name: string;
  readonly offerIds: readonly string[];
}

/** The optional emails a buyer can switch off; order updates are always sent. */
export interface EmailChoices {
  readonly offers: boolean;
  readonly recommendations: boolean;
  readonly sellerMessages: boolean;
}

/** The signed-in buyer's account: profile, orders, address book, lists and email choices. */
export interface AccountSource {
  /** True when the storefront talks to the API: the session, profile and address book are real. */
  readonly live: boolean;
  readonly customer: CheckoutCustomer;
  readonly mobile: string;
  /** Newest first. */
  readonly orders: readonly AccountOrder[];
  readonly lists: readonly NamedList[];
  readonly emails: EmailChoices;
  readonly serviceArea: ServiceArea;
}

/** One store card of the sellers page (`/sellers`). */
export interface SellerListing {
  /** The URL slug of the seller page. */
  readonly id: string;
  readonly name: string;
  /** Key of a sample logo; absent for a seller without a profile logo (the default tile shows). */
  readonly logo?: string;
  /** The logo the store uploaded; it wins over `logo`. Absent: the default tile shows. */
  readonly logoImage?: StoreImage;
  /** Suburb only; the seller's address is never shown. */
  readonly city: string;
  readonly sellingSince: number;
  /** Absent for a new seller without ratings; shown only behind the seller-ratings feature. */
  readonly ratings?: { readonly satisfaction: number; readonly count: number };
  /** The labels evaluateClaim allows the seller (CERT-*); never free text. */
  readonly certifications: readonly { readonly type: string; readonly name: string }[];
  readonly categories: readonly { readonly code: string; readonly name: string }[];
  /** Not known yet when absent. */
  readonly deliveryWindow?: string;
  /** Whether it delivers today to the buyer's location. */
  readonly sameDay: boolean;
  /** Absent when the seller has no minimum order (unless `minimumUnknown`). */
  readonly minimumOrder?: Money;
  /** The minimum order cannot be told now: no minimum line is shown. */
  readonly minimumUnknown?: true;
  /** Not known yet when absent. */
  readonly deliveryFee?: Money;
  /** Not known yet when absent. */
  readonly productCount?: number;
  /** Up to three products for the card's footer. */
  readonly thumbnails: readonly { readonly category: string; readonly imageUrl?: string }[];
  /** Whether it delivers to the buyer's location; true when the location is not known. */
  readonly deliversHere: boolean;
  /** Kilometres from the buyer's location; only when the location is inside the delivery area. */
  readonly distanceKm?: number;
}

/** A minimum-order bucket of the sellers filter; `max` absent for "No minimum order". */
export interface MinimumBucket {
  readonly id: string;
  readonly max?: Money;
}

/** Where the buyer's location stands against the delivery area. */
export type BuyerLocation = 'inside' | 'outside' | 'unknown';

/** The sellers page's read: filters and sort as the URL gives them, and how many to return. */
export interface SellerQuery {
  readonly filters: SellerFilters;
  readonly sort: SellerSort;
  readonly limit: number;
}

/** A filter option with the number of stores it holds, counted over every store. */
export interface SellerFacet {
  readonly id: string;
  readonly count: number;
}

export interface SellerFacets {
  readonly newSellers: number;
  readonly sameDay: number;
  readonly certifications: readonly (SellerFacet & { readonly name: string })[];
  readonly categories: readonly (SellerFacet & { readonly name: string })[];
  readonly minimums: readonly (SellerFacet & { readonly bucket: MinimumBucket })[];
  /** Only when the buyer's location is inside the delivery area. */
  readonly distances: readonly { readonly km: number; readonly count: number }[];
}

export interface SellerResults {
  /** The first `limit` matching stores, in the sort's order. */
  readonly items: readonly SellerListing[];
  /** Matching stores. */
  readonly total: number;
  /** Every store in the Market, with no filter; 0 means there are no sellers yet. */
  readonly all: number;
  readonly location: BuyerLocation;
  readonly facets: SellerFacets;
  /** The sorts the read can order by; every sort when absent. */
  readonly sorts?: readonly SellerSort[];
  /** False when the read cannot filter yet: the page offers no filter. */
  readonly filtersOffered?: false;
}

/**
 * A product that is no longer sold or was removed (`/p/<id>`). A sold-out product that is still
 * listed is a normal product page; this is only for removed ones. The reason is never shown.
 */
export interface UnavailableProduct {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly imageUrl?: string;
  readonly seller: { readonly id: string; readonly name: string };
  /** Up to four products: the same category first, then the same seller. */
  readonly similar: readonly ProductCard[];
}

/**
 * A store that is not taking orders (`/s/<slug>`): paused, suspended or not live yet. Buyers never
 * see which; the page shows the static facts only and other stores that deliver to them.
 */
export interface ClosedStore {
  readonly id: string;
  readonly name: string;
  /** Key of a sample logo; absent for a seller without a profile logo (the default tile shows). */
  readonly logo?: string;
  /** Suburb only; the seller's address is never shown. */
  readonly city: string;
  readonly sellingSince: number;
  readonly location: BuyerLocation;
  /** Up to three open stores that deliver to the buyer, as the sellers page shows them. */
  readonly others: readonly SellerListing[];
}

/**
 * What the sell page needs from the Market: the password rule, the area and business identifier
 * its copy names, and the seller panel's sign-in page. Never a default Market's values in code.
 */
export interface SellerSignUpSetup {
  readonly passwordMinLength: number;
  readonly passwordMaxLength: number;
  /** Where the Market sells now, for example "Greater Brisbane". */
  readonly serviceArea: string;
  /** The business identifier's short name, for example "ABN". */
  readonly businessIdentifier: string;
  /** The seller panel's sign-in page (another host: seller and customer accounts are separate). */
  readonly sellerSignInUrl: string;
}

/** The fields of the seller sign-up form. */
export type SellerSignUpField = 'name' | 'email' | 'password';

/** Why a field was refused; the form shows one message per code. */
export type SellerSignUpFieldError =
  | 'required'
  | 'name-length'
  | 'name-characters'
  | 'email-format'
  | 'password-short'
  | 'password-long'
  | 'password-common'
  | 'password-identity';

/**
 * The answer to a seller sign-up or a "send it again". `accepted` is the same for every address,
 * new or already registered (identity AC 21): the page never says whether an account exists.
 */
export type SellerSignUpAnswer =
  | { readonly kind: 'accepted' }
  | {
      readonly kind: 'invalid';
      readonly fields: Readonly<Partial<Record<SellerSignUpField, SellerSignUpFieldError>>>;
    }
  | { readonly kind: 'throttled'; readonly retryAfterSeconds: number }
  | { readonly kind: 'failed' };
