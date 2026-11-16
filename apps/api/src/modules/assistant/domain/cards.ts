import type { Money } from '@mondapac/shared-kernel';
import type { SitePage } from './tools';

/**
 * What the buyer sees of a tool result: a card built by the server from the owning module's data,
 * never from model text (plan section 5, guardrail 1). The storefront renders each card with its
 * own components and builds every link from these ids (R9).
 */
export type AssistantCard =
  | {
      readonly kind: 'product';
      readonly offerId: string;
      readonly productId: string;
      readonly sellerId: string;
      readonly name: string;
      readonly shortText: string | null;
      /** The public store name of the seller, as sellers answered it; null when unreadable. */
      readonly sellerName: string | null;
      /**
       * The lowest buyer price of the Offer now, as pricing answered it (Money, never Cost); null
       * when pricing could not be read, and then the card shows none. Never from model text.
       */
      readonly price: Money | null;
      /** The regular price, only while `price` is a special. */
      readonly regularPrice: Money | null;
      readonly taxInclusive: boolean | null;
      /** True when the Offer has Variants at different prices: `price` is then a "from" price. */
      readonly priceFrom: boolean;
      /**
       * Certification badges as catalog answered them live, only on the card of `get_product`.
       * Display only: never model text and never an input to `evaluateClaim` (ADR-0019 R1).
       */
      readonly badges: readonly { readonly typeCode: string; readonly typeName: string }[];
    }
  | {
      readonly kind: 'seller';
      readonly sellerId: string;
      /** The store's own page address (`/stores/<slug>`); the storefront builds the link. */
      readonly slug: string;
      readonly name: string;
      readonly city: string | null;
      readonly sellingSince: number;
      readonly productCount: number | null;
      readonly badges: readonly { readonly typeCode: string; readonly typeName: string }[];
    }
  | { readonly kind: 'page'; readonly page: SitePage; readonly categoryId: string | null }
  | { readonly kind: 'support'; readonly email: string | null };

/**
 * A fixed message the storefront shows in the buyer's language:
 * - `see-cards`, `see-certification`: the guard removed a claim (reply-guard.ts).
 * - `cart-actions-not-ready`, `support-form-not-ready`: actions not built yet (plan section 11).
 * - `unavailable`: the model could not answer; the storefront offers its normal search.
 * - `refused`: the model declined; the support card follows.
 * - `tool-failed`: a store read failed; nothing was guessed.
 */
export type AssistantNotice =
  | 'see-cards'
  | 'see-certification'
  | 'cart-actions-not-ready'
  | 'support-form-not-ready'
  | 'unavailable'
  | 'refused'
  | 'tool-failed';

/** The kind of every card in a reply, as stored with it (ids only, no text). */
export const cardRefOf = (card: AssistantCard): string =>
  card.kind === 'product'
    ? `product:${card.offerId}`
    : card.kind === 'seller'
      ? `seller:${card.sellerId}`
      : card.kind === 'page'
        ? `page:${card.page}`
        : 'support';
