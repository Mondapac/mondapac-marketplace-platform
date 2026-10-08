import type { MarketContext } from '@mondapac/shared-kernel';
import type { IdentifierIndexKey, NormalisedIdentifier } from '../../domain/business-identifier';

/**
 * `IdentifierIndex` (sellers design 7.6, 8.2; data design S5, 4.4): the keyed index of a
 * normalised identifier, bound to the Market and the scheme, so equal values in one Market
 * collide (uniqueness, exact search) and values in two Markets do not. Pseudonymous personal
 * data: it is never logged. Computed before the use case's unit (P 3.1 row 5: no hashing inside
 * a unit).
 */
export interface IdentifierIndex {
  of(market: MarketContext, scheme: string, normalised: NormalisedIdentifier): IdentifierIndexKey;
}

export const IDENTIFIER_INDEX = Symbol('IDENTIFIER_INDEX');
