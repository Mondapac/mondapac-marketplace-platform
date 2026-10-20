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
}

export interface ProductCard {
  readonly id: string;
  readonly name: string;
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

export interface SellerSummary {
  readonly id: string;
  readonly name: string;
  readonly initials: string;
  readonly deliveryWindow: string;
  readonly minimumOrder: string;
  /** Key of a sample logo; real sellers' logos arrive with media. */
  readonly logo?: string;
}

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
  readonly action: { readonly label: string; readonly href: string };
  readonly images: readonly string[];
}

/** One section of the admin-editable middle of the home page (handoffs/storefront.md). */
export type HomeSection =
  | { readonly kind: 'promos'; readonly banners: readonly PromoBanner[] }
  | { readonly kind: 'categories' }
  | { readonly kind: 'sellers'; readonly title: string; readonly href: string }
  | {
      readonly kind: 'products';
      readonly title: string;
      readonly href: string;
      readonly products: readonly ProductCard[];
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
  readonly city: string;
  readonly sellingSince: number;
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
  readonly seller: SellerProfile;
  readonly price: Money;
  readonly wasPrice?: Money;
  /** Badges built by certification from evaluateClaim for this offer. */
  readonly certifications: readonly CertificationBadge[];
  readonly lowStock?: number;
  readonly deliveryWindow: string;
  readonly minimumOrder: string;
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
  /** The seller's flat delivery fee for one order. */
  readonly deliveryFee: Money;
}

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
  readonly label: string;
  readonly name: string;
  readonly line: string;
  readonly phone: string;
  readonly isDefault: boolean;
}

/**
 * A sign-in provider the Market offers (social sign-in): the button's provider and the identity
 * API's start route the browser navigates to.
 */
export interface SignInProvider {
  readonly id: 'google';
  readonly startUrl: string;
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

/** The public seller page (`/s/<slug>`): profile, terms, certificates and products. */
export interface SellerShop {
  /** The URL slug. */
  readonly id: string;
  readonly name: string;
  /** Key of a sample logo; absent for a seller without a profile logo (the default tile shows). */
  readonly logo?: string;
  /** Suburb and city only; the seller's address is never shown. */
  readonly location: string;
  readonly sellingSince: number;
  readonly about: string;
  /** What the platform checked of the business, e.g. "ABN checked by Mondapac". */
  readonly businessCheck: string;
  readonly deliveryWindow: string;
  readonly deliveryFee: Money;
  /** Absent when the seller has no minimum order. */
  readonly minimumOrder?: Money;
  /** The area the seller delivers to. */
  readonly deliversTo: string;
  readonly certificates: readonly SellerCertificate[];
  /** Absent for a new seller without ratings; shown only behind the seller-ratings feature. */
  readonly ratings?: {
    readonly satisfaction: number;
    readonly onTime: number;
    readonly asDescribed: number;
    readonly count: number;
  };
  /** The categories of its products, in display order. */
  readonly categories: readonly { readonly code: string; readonly name: string }[];
  /** In popularity order. */
  readonly products: readonly SellerProduct[];
}

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
  readonly customer: CheckoutCustomer;
  readonly mobile: string;
  /** Newest first. */
  readonly orders: readonly AccountOrder[];
  readonly lists: readonly NamedList[];
  readonly emails: EmailChoices;
  readonly serviceArea: ServiceArea;
}
