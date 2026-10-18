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
