import type { CallContext, Id, Temporal } from '@mondapac/shared-kernel';

/**
 * Since when a seller has been active (selling) in the Market: the clock of the "active for fewer
 * than 30 days needs approval" rule. Null when it is not known; the rule then treats the seller
 * as new (fail closed). `sellers` publishes no such read yet, so the shipped adapter always
 * answers null; a later package replaces it with a call of the sellers facade. Called before any
 * unit opens.
 */
export interface SellerActivity {
  activeSince(context: CallContext, sellerId: Id<'Seller'>): Promise<Temporal.Instant | null>;
}

export const SELLER_ACTIVITY = Symbol('PROMOTIONS_SELLER_ACTIVITY');
