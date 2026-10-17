/**
 * The named review checks of a product revision (catalog design 8.3a; Hassan H1): the codes a
 * reviewer ticks on an approval. The codes are fixed here until the Market list
 * `catalog.reviewChecks` (design 7.1) is stored.
 */
export const REVIEW_CHECK_CODES = [
  'photos-no-certification-mark',
  'category-fits',
  'tax-category-fits',
  'not-a-duplicate',
] as const;
export type ReviewCheckCode = (typeof REVIEW_CHECK_CODES)[number];
