/**
 * `ProductRevisionPolicy` (catalog design 4.3; VER-02, VER-03): a pure domain service that says
 * whether a candidate revision differs from the published one in a sensitive way, and whether
 * a revision is published at once or waits for review. No clock, no store, no configuration
 * read: the Market's `sensitiveChanges` and the `catalog.approval-required` value are inputs.
 */

/** The codes of D 9.2a, spelled as the `product_revisions.sensitive_reasons` CHECK. */
export const SENSITIVE_REASONS = [
  'platform-categories',
  'tax-category',
  'name',
  'primary-image',
  'image-added-or-replaced',
  'variant-removed',
  'never-published',
  'approval-required',
] as const;
export type SensitiveReason = (typeof SENSITIVE_REASONS)[number];

/** The Market's `catalog.sensitiveChanges` (design 7.1). Each flag makes that change sensitive. */
export interface SensitiveChangesPolicy {
  readonly platformCategories: boolean;
  readonly taxCategory: boolean;
  readonly name: boolean;
  readonly primaryImage: boolean;
  /** Any image added or replaced (Hassan, G1). Images always go to review anyway (H1). */
  readonly anyImage: boolean;
  readonly variantRemoved: boolean;
}

/** What the policy reads of a revision's content. Ids and the text of names only. */
export interface RevisionSummary {
  /** Product name per locale. */
  readonly names: Readonly<Record<string, string>>;
  readonly categoryIds: readonly string[];
  readonly taxCategoryCode: string;
  /** Image ids in position order; position 1 is the primary image. Empty until slice 13. */
  readonly imageIds: readonly string[];
  readonly variantIds: readonly string[];
}

export interface Classification {
  readonly sensitive: boolean;
  readonly reasons: readonly SensitiveReason[];
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return (
    a.length === b.length && new Set(a).size === new Set(b).size && a.every((x) => b.includes(x))
  );
}

function sameNames(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/**
 * Classifies `candidate` against the `published` revision (null for a product never published).
 * A never-published product is always sensitive. Otherwise the reasons are the Market's
 * sensitive fields that changed, plus `image-added-or-replaced` whenever the image set changed,
 * whatever the Market says (Hassan H1: text is machine-checked, photos are not).
 */
export function classify(
  published: RevisionSummary | null,
  candidate: RevisionSummary,
  policy: SensitiveChangesPolicy,
): Classification {
  if (published === null) return { sensitive: true, reasons: ['never-published'] };
  const reasons: SensitiveReason[] = [];
  if (policy.platformCategories && !sameSet(published.categoryIds, candidate.categoryIds)) {
    reasons.push('platform-categories');
  }
  if (policy.taxCategory && published.taxCategoryCode !== candidate.taxCategoryCode) {
    reasons.push('tax-category');
  }
  if (policy.name && !sameNames(published.names, candidate.names)) reasons.push('name');
  if (policy.primaryImage && published.imageIds[0] !== candidate.imageIds[0]) {
    reasons.push('primary-image');
  }
  const imageAddedOrReplaced = candidate.imageIds.some((id) => !published.imageIds.includes(id));
  if (imageAddedOrReplaced) reasons.push('image-added-or-replaced');
  if (
    policy.variantRemoved &&
    published.variantIds.some((id) => !candidate.variantIds.includes(id))
  ) {
    reasons.push('variant-removed');
  }
  return { sensitive: reasons.length > 0, reasons };
}

export interface OutcomeInput {
  readonly classification: Classification;
  /** `catalog.approval-required`, read in the submitting unit (CAT-36; ADR-0026 d2). */
  readonly approvalRequired: boolean;
  /** Another sensitive revision of this product is waiting for review (AC 26). */
  readonly sensitiveRevisionPending: boolean;
  /**
   * `seller`: a seller's submit. `admin-platform`: an admin's revision of a PLATFORM product
   * (CAT-41). `tax-override`: an admin's override of a SELLER product's tax category (AC 36).
   */
  readonly author: 'seller' | 'admin-platform' | 'tax-override';
}

export type RevisionOutcome =
  | {
      readonly outcome: 'published';
      readonly publishKind: 'auto' | 'admin-authored';
      readonly sensitive: boolean;
      readonly reasons: readonly SensitiveReason[];
    }
  | {
      readonly outcome: 'pending';
      readonly publishKind: null;
      readonly sensitive: boolean;
      readonly reasons: readonly SensitiveReason[];
    };

/**
 * Published at once or pending (design 4.2 rows 1 and 4, 4.3). An admin's PLATFORM revision and
 * a tax override publish at once. For a seller: a revision that adds or replaces an image is
 * always reviewed (H1); with approval off everything else publishes at once; with approval on a
 * never-published product and a sensitive change wait, and so does any change while a sensitive
 * revision is pending (the next submit supersedes it and stays pending, AC 26). A revision that
 * waits for no field reason carries `approval-required`.
 */
export function decideOutcome(input: OutcomeInput): RevisionOutcome {
  const { classification } = input;
  if (input.author !== 'seller') {
    return {
      outcome: 'published',
      publishKind: 'admin-authored',
      sensitive: classification.sensitive,
      reasons: classification.reasons,
    };
  }
  const imageChange = classification.reasons.includes('image-added-or-replaced');
  const published =
    !imageChange &&
    (!input.approvalRequired || (!classification.sensitive && !input.sensitiveRevisionPending));
  if (published) {
    return {
      outcome: 'published',
      publishKind: 'auto',
      sensitive: classification.sensitive,
      reasons: classification.reasons,
    };
  }
  const reasons: readonly SensitiveReason[] =
    classification.reasons.length > 0 ? classification.reasons : ['approval-required'];
  return { outcome: 'pending', publishKind: null, sensitive: true, reasons };
}
