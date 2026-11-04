import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { ClaimTextCheckUnavailable } from './claim-text-matcher';

/**
 * The locales in which the claim-text check can find a claim word (attributes A2): those where
 * every certification type of the Market has at least one term. A text in another locale cannot be
 * checked, so a writer refuses it (fail closed, never a bypass). Bound to
 * `certification.claimTermLocales`; the facade opens its own read-only unit, so no caller may hold a
 * unit of work open. Any refusal, fault or answer of the wrong shape is unavailable.
 */
export interface ClaimTermLocales {
  covered(context: CallContext): Promise<Result<readonly string[], ClaimTextCheckUnavailable>>;
}

export const CLAIM_TERM_LOCALES = Symbol('CATALOG_CLAIM_TERM_LOCALES');
