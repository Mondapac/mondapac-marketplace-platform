// Data of the type wording rules (new-type design section 5; FE-091). Hassan (security) owns these
// lists: change them only with his review and a matching case in type-revision.spec.ts. Both are
// compared after the claim-text matcher's own normalisation (look-alike letters, case, leet), so a
// disguised spelling is caught as the plain one.

/**
 * Words and phrases a type's customer-facing name or description must not use (design 5): the text
 * says what the platform checked, never a ruling, a guarantee, a health or allergy outcome, or that
 * MondaPac itself certifies (CLAUDE.md R13, R14). Matched as whole words or word sequences, so
 * "secure" never matches "cure".
 */
export const FORBIDDEN_TYPE_TEXT_WORDS: readonly string[] = Object.freeze([
  'guarantee',
  'guarantees',
  'guaranteed',
  'fatwa',
  'ruling',
  'rulings',
  'cure',
  'cures',
  'allergy',
  'allergies',
  'allergen',
  'allergens',
  'healthy',
  'certified by mondapac',
  'mondapac certified',
]);

/**
 * Claim terms too common to be a certification claim (design 5): a type whose term is one of these
 * would block ordinary product text across the Market once active. A whole term equal to one of
 * them is refused; a phrase that contains one ("certified organic") is fine.
 */
export const CLAIM_TERM_STOP_LIST: readonly string[] = Object.freeze([
  'the',
  'and',
  'for',
  'with',
  'food',
  'foods',
  'product',
  'products',
  'item',
  'items',
  'fresh',
  'natural',
  'quality',
  'premium',
  'pure',
  'original',
  'new',
  'best',
  'free',
  'made',
  'local',
  'australian',
  'certified',
  'certificate',
  'certification',
  'approved',
  'verified',
  'official',
  'authentic',
  'genuine',
]);
