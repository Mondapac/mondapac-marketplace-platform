import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { BasketCandidate, CartMode } from '../../domain/plan-basket';

/**
 * What the basket planner reads from the other modules, through their facades and with the
 * buyer's own `CallContext` (ADR-0019 R3). A read that fails is an error, never "nothing found":
 * the planner would otherwise tell the buyer a product does not exist.
 */
export interface BasketSources {
  /** The products the buyer's own storefront search shows for one line, best match first. */
  candidates(
    context: CallContext,
    text: string,
  ): Promise<Result<readonly BasketCandidate[], { readonly code: 'unavailable' }>>;
  /** The Market's cart mode; `multi-store` when it cannot be read (the cart enforces its own). */
  cartMode(context: CallContext): Promise<CartMode>;
}

export const BASKET_SOURCES = Symbol('BASKET_SOURCES');
