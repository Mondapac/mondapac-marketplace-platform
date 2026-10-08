import type { MarketContext } from '@mondapac/shared-kernel';
import type { IdentifierRules } from '../../domain/business-identifier';

/**
 * `BusinessIdentifierScheme` (sellers design 4.2): the pure rules of one scheme, the interface
 * the domain's `parseBusinessIdentifier` takes. Re-exported here as the port's name.
 */
export type BusinessIdentifierScheme = IdentifierRules;

/**
 * The scheme of a Market, chosen by its configuration (`sellers.businessIdentifier.scheme`,
 * design 4.1). Null for a Market with no `sellers` section: the caller refuses, it never validates
 * against another Market's scheme. A scheme the configuration names but no adapter implements is
 * refused at start-up, so a hosted Market never reaches a missing adapter at run time.
 */
export interface BusinessIdentifierSchemes {
  schemeOf(market: MarketContext): BusinessIdentifierScheme | null;
}

export const BUSINESS_IDENTIFIER_SCHEMES = Symbol('BUSINESS_IDENTIFIER_SCHEMES');
