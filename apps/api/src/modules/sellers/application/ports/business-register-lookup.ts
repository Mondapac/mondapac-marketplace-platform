import type { MarketContext } from '@mondapac/shared-kernel';
import type { NormalisedIdentifier } from '../../domain/business-identifier';
import type { RegisterValues } from '../../domain/register-comparison';

/**
 * `BusinessRegisterLookup` (sellers design 4.2, 7.7): asks the Market's business register about
 * one identifier. The adapter is chosen by Market configuration (`registerLookup.adapter`), is
 * named after the register and holds no Market code. By identifier only: there is no search by
 * name (brief s5).
 */
export interface RegisterLookupRequest {
  readonly market: MarketContext;
  /** The scheme code of the Market's identifier (design 4.1). */
  readonly scheme: string;
  /** The validated, normalised identifier: the only variable of the outbound request (L7). */
  readonly identifier: NormalisedIdentifier;
}

/**
 * What the register answered, already reduced to the design's closed outcomes (3.4). `values`
 * is what the register said about the business, for the comparison only: it is never stored,
 * logged or shown to the seller. Anything the adapter cannot read with certainty (a timeout, a
 * refusal, a malformed, too large or redirected answer) is `unavailable` (AC 32).
 */
export type RegisterAnswer =
  | { readonly outcome: 'active'; readonly values: RegisterValues }
  | { readonly outcome: 'not-found' | 'cancelled' | 'unavailable' };

export interface BusinessRegisterLookup {
  /** The adapter's code in Market configuration (`none`, `fake`, a register's name). */
  readonly code: string;
  /**
   * Whether `lookup` reaches a register. `none` does not: the caller then reserves no quota,
   * calls nothing and writes no result (the state of the file stays `not-performed`).
   */
  readonly performsLookups: boolean;
  /**
   * Called outside any unit of work. A register-side failure is the answer `unavailable`, not an
   * exception; the caller also treats a throw as `unavailable`. Never logs the identifier or the
   * raw answer.
   */
  lookup(request: RegisterLookupRequest): Promise<RegisterAnswer>;
}

/** The adapter of each hosted Market, chosen by its configuration; never another Market's. */
export interface BusinessRegisterLookups {
  of(market: MarketContext): BusinessRegisterLookup;
}

export const BUSINESS_REGISTER_LOOKUPS = Symbol('BUSINESS_REGISTER_LOOKUPS');
