import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { ClaimTextToMatch } from './claim-text-matcher';

/** A candidate term list: the terms a type revision would publish, per locale. */
export interface CandidateTerms {
  readonly typeCode?: string;
  readonly termsByLocale: Readonly<Record<string, readonly string[]>>;
}

/** A candidate the matcher cannot use (the terms are refused whole), or no answer at all. */
export type CandidateMatchFailure =
  | { readonly code: 'claim-text.check-unavailable' }
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

/**
 * Matching of a CANDIDATE term list against texts (catalog design 6.5), owned by `catalog` and
 * bound to `certification.matchCandidateClaimTerms` (request X-1). Answers, per text, whether
 * any candidate term matched. The facade opens its own unit when it needs one, so no caller may
 * hold a unit of work open (units do not nest). The caller's {@link CallContext} goes through
 * unchanged. Any fault or answer of the wrong shape is unavailable, never zero.
 */
export interface ClaimTermsCandidateMatcher {
  matches(
    context: CallContext,
    candidate: CandidateTerms,
    texts: readonly ClaimTextToMatch[],
  ): Promise<Result<readonly boolean[], CandidateMatchFailure>>;
}

export const CLAIM_TERMS_CANDIDATE_MATCHER = Symbol('CATALOG_CLAIM_TERMS_CANDIDATE_MATCHER');
