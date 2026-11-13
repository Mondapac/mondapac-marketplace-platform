import type { Id } from '@mondapac/shared-kernel';
import type { CultureStatus } from './culture';
import type { EffectiveCategoryMarks } from './culture-category';

// The visibility rule of multi-culture (ADR-0047 decision 5, with ADR-0048 security review M2;
// package 3a). Pure: the use case gathers the facts through the facades of `sellers` and
// `certification` and catalog's own tables, and any failure to gather them is "not visible" before
// this function is reached (fail closed). Core code never names a culture (ADR-0001 decision 5):
// a culture is data, and its certification type is a code from certification's registry.

/** A culture as the rule needs it. */
export interface VisibilityCulture {
  readonly id: Id<'Culture'>;
  readonly code: string;
  readonly status: CultureStatus;
  readonly displayOrder: number;
  /** The certification type a member must hold a valid certificate of, or null. */
  readonly requiredCertificationType: string | null;
}

/** What is known of one Offer, read in the request that asks. */
export interface OfferCultureFacts {
  /** The cultures the Offer's seller is `approved` in (sellers' membership). */
  readonly approvedCultureIds: ReadonlySet<Id<'Culture'>>;
  /** The certification types the seller holds a valid certificate of now (M2). */
  readonly sellerValidTypes: ReadonlySet<string>;
  /**
   * Per culture, the effective marks of each platform category of the Offer's product (one entry
   * per category, `resolveEffectiveMarks` on the live tree). A culture absent from the map, or an
   * empty list, means the categories are unknown: not visible.
   */
  readonly categoryMarks: ReadonlyMap<Id<'Culture'>, readonly EffectiveCategoryMarks[]>;
  /**
   * The types of the Offer's stored `active` tags that certification's `evaluateClaims` allowed in
   * this request (every variant, on the stored basis). Never inferred from anything else.
   */
  readonly allowedTagTypes: ReadonlySet<string>;
}

export type CultureVisibilityReason =
  | 'visible'
  | 'culture-not-active'
  | 'not-member'
  | 'no-category'
  | 'category-hidden'
  | 'certificate-invalid'
  | 'tag-not-allowed';

export interface CultureVisibility {
  readonly visible: boolean;
  readonly reason: CultureVisibilityReason;
}

const hidden = (reason: Exclude<CultureVisibilityReason, 'visible'>): CultureVisibility => ({
  visible: false,
  reason,
});

/**
 * Whether one Offer is visible in one culture. All of these must hold:
 * 1. the culture is `active`;
 * 2. the Offer's seller is approved in it;
 * 3. every platform category of the product is visible there (a product in a hidden branch is
 *    hidden even when another of its categories is visible; a product with no platform category is
 *    not visible, since nothing can be resolved for it);
 * 4. for a culture with a required certification type: the seller holds a valid certificate of
 *    that type now (M2: an expired or revoked certificate hides the seller's Offers in that culture,
 *    neutral categories included), and unless every category is marked "neutral", the Offer carries
 *    a tag of that type that `evaluateClaims` allowed now. A "neutral" category needs membership
 *    only; a category is "required" by default.
 */
export function cultureVisibility(
  culture: VisibilityCulture,
  facts: OfferCultureFacts,
): CultureVisibility {
  if (culture.status !== 'active') return hidden('culture-not-active');
  if (!facts.approvedCultureIds.has(culture.id)) return hidden('not-member');
  const categories = facts.categoryMarks.get(culture.id) ?? [];
  if (categories.length === 0) return hidden('no-category');
  if (categories.some((marks) => !marks.visible)) return hidden('category-hidden');
  const type = culture.requiredCertificationType;
  if (type === null) return { visible: true, reason: 'visible' };
  if (!facts.sellerValidTypes.has(type)) return hidden('certificate-invalid');
  const needsTag = categories.some((marks) => marks.certificationMark === 'required');
  if (needsTag && !facts.allowedTagTypes.has(type)) return hidden('tag-not-allowed');
  return { visible: true, reason: 'visible' };
}

/** What the line rule reads of a culture. */
export type LineCultureCandidate = Pick<
  VisibilityCulture,
  'code' | 'displayOrder' | 'requiredCertificationType'
>;

/** Display order, then code: the order cultures are listed in, and the tie-break of the line rule. */
export const byDisplayOrder = (a: LineCultureCandidate, b: LineCultureCandidate): number =>
  a.displayOrder - b.displayOrder || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);

/**
 * The codes of the cultures the Offer is visible in, by display order then code. `null` facts
 * (the facts could not be read) are visible nowhere.
 */
export function visibleCultureCodes(
  cultures: readonly VisibilityCulture[],
  facts: OfferCultureFacts | null,
): readonly string[] {
  if (facts === null) return [];
  return [...cultures]
    .sort(byDisplayOrder)
    .filter((culture) => cultureVisibility(culture, facts).visible)
    .map((culture) => culture.code);
}

/**
 * The culture of a cart or order line (ADR-0047 decision 9): among the cultures in which the Offer
 * is visible and the buyer chose, a culture with a required certification type wins; in every other
 * tie (two certified or two uncertified) the lower display order wins, then the code, so the
 * answer never depends on the order given. Null when there is none. Package 7 stores it on the line.
 */
export function lineCultureOf(candidates: readonly LineCultureCandidate[]): string | null {
  const certifiedFirst = (a: LineCultureCandidate, b: LineCultureCandidate): number =>
    Number(b.requiredCertificationType !== null) - Number(a.requiredCertificationType !== null) ||
    byDisplayOrder(a, b);
  return [...candidates].sort(certifiedFirst)[0]?.code ?? null;
}
