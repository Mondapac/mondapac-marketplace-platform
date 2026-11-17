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
  'gtin-changed',
  'axis-added',
  'topics-changed',
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
  /** Kept for the Market config shape (7.1); ignored by `classify`, as images always go to review (H1). */
  readonly anyImage: boolean;
  readonly variantRemoved: boolean;
  /** A GTIN set, changed or cleared on a variant that was already published (variants V4). */
  readonly gtinChanged: boolean;
  /** A second variant axis added to a published product (variants V9b). */
  readonly axisAdded: boolean;
}

/** What the policy reads of a revision's content. Ids and the text of names only. */
export interface RevisionSummary {
  /** Product name per locale. */
  readonly names: Readonly<Record<string, string>>;
  readonly categoryIds: readonly string[];
  /** Topic ids in the order entered (product tags T2). */
  readonly topicIds: readonly string[];
  readonly taxCategoryCode: string;
  /** Image ids in position order; position 1 is the primary image. Empty until slice 13. */
  readonly imageIds: readonly string[];
  readonly variantIds: readonly string[];
  /** Variant id to its 14-digit GTIN, or null (V4). */
  readonly variantGtins: Readonly<Record<string, string | null>>;
  /** The option attribute codes the variants vary on (V9b); empty for a Simple product. */
  readonly variantAxes: readonly string[];
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
 * A never-published product is always sensitive, and with images it also adds `image-added-or-replaced`. Otherwise the reasons are the Market's
 * sensitive fields that changed, plus `image-added-or-replaced` whenever the image set changed,
 * whatever the Market says (Hassan H1: text is machine-checked, photos are not).
 */
export function classify(
  published: RevisionSummary | null,
  candidate: RevisionSummary,
  policy: SensitiveChangesPolicy,
): Classification {
  if (published === null) {
    // Every first revision carries its images, so it goes to review even with approval off (H1).
    const reasons: SensitiveReason[] = ['never-published'];
    if (candidate.imageIds.length > 0) reasons.push('image-added-or-replaced');
    // Topics of a first revision are reviewed with it, and force review like an image does.
    if (candidate.topicIds.length > 0) reasons.push('topics-changed');
    return { sensitive: true, reasons };
  }
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
  // Only a variant that is in both revisions can change its GTIN; a new variant is not a change,
  // so adding a variant with or without a GTIN stays minor unless it adds an image (V4, t13).
  if (
    policy.gtinChanged &&
    candidate.variantIds.some(
      (id) =>
        Object.hasOwn(published.variantGtins, id) &&
        (published.variantGtins[id] ?? null) !== (candidate.variantGtins[id] ?? null),
    )
  ) {
    reasons.push('gtin-changed');
  }
  // A second axis rewrites the option values and labels of every variant. A Simple product made
  // Configurable (published axes none) is not this change (M-9).
  if (
    policy.axisAdded &&
    published.variantAxes.length > 0 &&
    candidate.variantAxes.some((code) => !published.variantAxes.includes(code))
  ) {
    reasons.push('axis-added');
  }
  // Any difference between the two topic sets is a tag change and is always reviewed: not a Market
  // flag (decision 3 of the tags design). The order is not a tag change, so a reorder alone is minor.
  if (!sameSet(published.topicIds, candidate.topicIds)) reasons.push('topics-changed');
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
 * always reviewed (H1), and so is a topic change; with approval off everything else publishes at once; with approval on a
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
  // A photo change and a topic change are reviewed whatever the Market says (H1, tags decision 3).
  const alwaysReviewed =
    classification.reasons.includes('image-added-or-replaced') ||
    classification.reasons.includes('topics-changed');
  const published =
    !alwaysReviewed &&
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
