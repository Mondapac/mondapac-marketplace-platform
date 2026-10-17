import { REVIEW_CHECK_CODES, type ReviewCheckCode } from '../../domain/review-check-codes';

export { REVIEW_CHECK_CODES, type ReviewCheckCode };

// The named review checks of a product revision (catalog design 8.3a; Hassan H1). The server
// derives the set a reviewer must confirm from the revision's classification and whether the
// product was ever published, never from the request.

/**
 * The checks required to approve a revision. `reasons` are the classification codes stored on the
 * revision (design 4.3); an unknown code adds nothing. A first publication needs all four; an
 * image added or replaced always needs the photo check (H1); a changed category or tax category
 * needs its own check.
 */
export function requiredChecksOf(input: {
  readonly firstPublication: boolean;
  readonly reasons: readonly string[];
}): readonly ReviewCheckCode[] {
  const has = (reason: string) => input.reasons.includes(reason);
  const required = new Set<ReviewCheckCode>();
  if (input.firstPublication) {
    for (const code of REVIEW_CHECK_CODES) required.add(code);
  }
  if (has('image-added-or-replaced') || has('primary-image')) {
    required.add('photos-no-certification-mark');
  }
  if (has('platform-categories')) required.add('category-fits');
  if (has('tax-category')) required.add('tax-category-fits');
  return REVIEW_CHECK_CODES.filter((code) => required.has(code));
}
