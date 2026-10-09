import type { MarketContext } from '@mondapac/shared-kernel';
import type { CartLimits } from '../../domain/cart';

/** The Market settings the cart reads. */
export interface CartPolicy {
  limits(market: MarketContext): CartLimits;
  /** How long a guest cart lives after its last change, in milliseconds (7 days). */
  guestTtlMs(): number;
}

export const CART_POLICY = Symbol('CART_POLICY');
