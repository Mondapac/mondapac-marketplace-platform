import type { CallContext, Result } from '@mondapac/shared-kernel';

/** One text to match. The locale is the text's declared one; the matcher ignores it (M8). */
export interface ClaimTextToMatch {
  readonly locale: string;
  readonly text: string;
}

/** One occurrence: the type whose term matched, and the token span of a first-pass match. */
export interface ClaimTextMatch {
  readonly typeCode: string;
  /** Token indexes in the normalised text; `null` for a match found with separators removed. */
  readonly span: { readonly fromToken: number; readonly toToken: number } | null;
}

/** The only failure the port has: there is no partial answer, and the caller refuses (M8). */
export interface ClaimTextCheckUnavailable {
  readonly code: 'claim-text.check-unavailable';
}

/** The most texts one call may carry (the matcher's own limit, `certification` design 8.1). */
export const MAX_MATCH_TEXTS = 100;
/** The longest text one call may carry. */
export const MAX_MATCH_TEXT_LENGTH = 20_000;

/**
 * Matching of claim terms (catalog design 6.1), owned by `catalog` and bound to
 * `certification.matchClaimTerms` once that binding PR merges. Until then the composition root
 * binds the fail-closed placeholder of ADR-0031 and every check answers unavailable. The call
 * carries the caller's {@link CallContext} unchanged; the answer is one list of matches per text,
 * in order, and any other shape is treated as unavailable by the consumer.
 */
export interface ClaimTextMatcher {
  match(
    context: CallContext,
    texts: readonly ClaimTextToMatch[],
  ): Promise<Result<readonly (readonly ClaimTextMatch[])[], ClaimTextCheckUnavailable>>;
}

export const CLAIM_TEXT_MATCHER = Symbol('CATALOG_CLAIM_TEXT_MATCHER');
