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
      /** Only on the specials shelf, as pricing answered it; otherwise the card has no price. */
      readonly price: Money | null;
      readonly regularPrice: Money | null;
      readonly taxInclusive: boolean | null;
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
    : card.kind === 'page'
      ? `page:${card.page}`
      : 'support';
