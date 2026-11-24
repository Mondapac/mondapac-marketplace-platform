import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

/** The live listings of a Market and how many of them have no sell unit in stock. */
export interface LiveListingCounts {
  /** Sellable Offers: one document each (published, listed, the seller may sell). */
  readonly active: number;
  /** Of {@link active}, the Offers with no sell unit that inventory reports in stock or low. */
  readonly outOfStock: number;
}

/**
 * The search read model's supply numbers for the admin dashboard (dashboards v2, phase 1, PR 6).
 * Runs its use case with the caller's `CallContext` unchanged, so its key is checked
 * (`catalog.product.view`, platform admins only). Not exposed over HTTP; the dashboard module
 * composes it.
 */
export interface SearchSupplyFacade {
  /** The live listings and how many have no sell unit in stock. `signal`: the dashboard's limit. */
  liveListings(
    context: CallContext,
    query: { readonly signal: AbortSignal },
  ): Promise<Result<LiveListingCounts, AccessDenied>>;
}

/** Nest token of the {@link SearchSupplyFacade}, provided and exported by `SearchModule`. */
export const SEARCH_SUPPLY_FACADE = Symbol('SEARCH_SUPPLY_FACADE');
