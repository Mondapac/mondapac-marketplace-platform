import { auditField, defineAuditAction } from '@mondapac/shared-kernel';
import type { ProductScope } from './product';

// The audited actions of catalog (catalog design 11.3), registered at boot with
// `registerAuditActions('catalog', CATALOG_AUDIT_ACTIONS)`. Ids, codes, counts and booleans only:
// no name, no text, no reason text. The actor is the admin of the context.

/** The audit target type of a product. */
export const CATALOG_PRODUCT_TARGET = 'catalog.product';

const scope = auditField.enumOf(['platform', 'seller'] as const);

/** The audit code of a product scope (audit enums are lower-case codes). */
export const scopeCode = (value: ProductScope): 'platform' | 'seller' =>
  value === 'PLATFORM' ? 'platform' : 'seller';

/** An admin paused a published product (design 4.1a); its Offers went off sale with it. */
export const ProductPausedAudit = defineAuditAction({
  action: 'catalog.product.paused',
  targetType: CATALOG_PRODUCT_TARGET,
  actors: ['authenticated'],
  before: { paused: auditField.boolean() },
  after: { paused: auditField.boolean(), scope, offerCount: auditField.integer() },
});

/** An admin resumed a paused product (design 4.1a); its Offers were asked again and listed. */
export const ProductResumedAudit = defineAuditAction({
  action: 'catalog.product.resumed',
  targetType: CATALOG_PRODUCT_TARGET,
  actors: ['authenticated'],
  before: { paused: auditField.boolean() },
  after: { paused: auditField.boolean(), scope, offerCount: auditField.integer() },
});

/**
 * An admin deleted an unused photo from the library of a PLATFORM product (P1 admin product
 * images). The ids only: the picture itself is never in the audit log.
 */
export const ProductImageDeletedAudit = defineAuditAction({
  action: 'catalog.product.image-deleted',
  targetType: CATALOG_PRODUCT_TARGET,
  actors: ['authenticated'],
  before: { imageId: auditField.id() },
  after: { imageId: auditField.optional(auditField.id()) },
});

/** A SELLER product was withdrawn by an admin (design 4.1); its Offer was deleted. */
export const ProductWithdrawnAudit = defineAuditAction({
  action: 'catalog.product.withdrawn',
  targetType: CATALOG_PRODUCT_TARGET,
  actors: ['authenticated'],
  before: { status: auditField.enumOf(['unpublished', 'published'] as const) },
  after: {
    status: auditField.enumOf(['withdrawn'] as const),
    scope,
    offerCount: auditField.integer(),
  },
});

/** A PLATFORM product was retired (design 4.1; CAT-48) with the Offer count the admin confirmed. */
export const ProductRetiredAudit = defineAuditAction({
  action: 'catalog.product.retired',
  targetType: CATALOG_PRODUCT_TARGET,
  actors: ['authenticated'],
  before: { status: auditField.enumOf(['published'] as const), paused: auditField.boolean() },
  after: {
    status: auditField.enumOf(['retired'] as const),
    scope,
    offerCount: auditField.integer(),
    confirmedOfferCount: auditField.integer(),
  },
});

/**
 * A Simple product became Configurable by Add sizes (design 4.2a; variants V9): ids, codes and
 * counts only. `offerCount` is the Offers on the product when it changed, `offOfferCount` those of
 * sellers who may not sell the new type, which went off sale with the cause `type-not-allowed`.
 */
export const ProductTypeChangedAudit = defineAuditAction({
  action: 'catalog.product.type-changed',
  targetType: CATALOG_PRODUCT_TARGET,
  actors: ['authenticated'],
  before: { typeCode: auditField.enumOf(['simple'] as const) },
  after: {
    typeCode: auditField.enumOf(['configurable'] as const),
    scope,
    offerCount: auditField.integer(),
    offOfferCount: auditField.integer(),
    axisCount: auditField.integer(),
  },
});

/** The audit target type of a platform import job. */
export const CATALOG_PLATFORM_IMPORT_TARGET = 'catalog.platform-import';

/**
 * An admin confirmed a platform import (design 14a): the file was checked, the choice made and the
 * run queued. Counts and the choice only; the file's SHA-256 is on the job row (`file_sha256`), which
 * the audit target id points to, because the audit vocabulary has no text field.
 */
export const PlatformImportStartedAudit = defineAuditAction({
  action: 'catalog.platform-import.started',
  targetType: CATALOG_PLATFORM_IMPORT_TARGET,
  actors: ['authenticated'],
  before: { state: auditField.enumOf(['checked'] as const) },
  after: {
    state: auditField.enumOf(['queued'] as const),
    startAs: auditField.enumOf(['inactive', 'active'] as const),
    skipErrors: auditField.boolean(),
    rows: auditField.integer(),
    toImport: auditField.integer(),
    errorRows: auditField.integer(),
  },
});

/** The audit target type of a seller import job. */
export const CATALOG_SELLER_IMPORT_TARGET = 'catalog.seller-import';

/**
 * A seller's member confirmed an import (design 14c): the file was checked, the choice made and the
 * run queued. Counts and the mode only; the file's SHA-256 is on the job row (`file_sha256`), which
 * the audit target id points to, because the audit vocabulary has no text field.
 */
export const OwnImportStartedAudit = defineAuditAction({
  action: 'catalog.own-import.started',
  targetType: CATALOG_SELLER_IMPORT_TARGET,
  actors: ['authenticated'],
  before: { state: auditField.enumOf(['checked'] as const) },
  after: {
    state: auditField.enumOf(['queued'] as const),
    mode: auditField.enumOf(['my-products', 'sell-from-catalogue'] as const),
    skipErrors: auditField.boolean(),
    rows: auditField.integer(),
    toImport: auditField.integer(),
    errorRows: auditField.integer(),
  },
});

/** The audit target type of a saved filter. */
export const CATALOG_SAVED_FILTER_TARGET = 'catalog.saved-filter';

const savedFilterVisibility = auditField.enumOf(['me', 'everyone'] as const);

/** The lists a saved filter can belong to (the keys of `SAVED_FILTER_LISTS`). */
export const SAVED_FILTER_AUDIT_LISTS = [
  'admin.catalog.products',
  'seller.catalog.products',
] as const;
export type SavedFilterAuditList = (typeof SAVED_FILTER_AUDIT_LISTS)[number];
const savedFilterList = auditField.enumOf(SAVED_FILTER_AUDIT_LISTS);

/**
 * An admin or a seller member saved a filter for everyone (design 9.2d, 9.2e). The name is not
 * audited: ids and codes only.
 */
export const SavedFilterSharedAudit = defineAuditAction({
  action: 'catalog.saved-filter.shared',
  targetType: CATALOG_SAVED_FILTER_TARGET,
  actors: ['authenticated'],
  after: { listKey: savedFilterList, visibility: savedFilterVisibility },
});

/**
 * An admin changed a filter that is, or was, shared with everyone: renamed it or moved it between
 * "me" and "everyone". `ownedByActor` is false when an admin with the share key changed somebody
 * else's filter.
 */
export const SavedFilterChangedAudit = defineAuditAction({
  action: 'catalog.saved-filter.changed',
  targetType: CATALOG_SAVED_FILTER_TARGET,
  actors: ['authenticated'],
  before: { visibility: savedFilterVisibility },
  after: {
    listKey: savedFilterList,
    visibility: savedFilterVisibility,
    renamed: auditField.boolean(),
    ownedByActor: auditField.boolean(),
  },
});

/** An admin deleted a filter that was shared with everyone. */
export const SavedFilterRemovedAudit = defineAuditAction({
  action: 'catalog.saved-filter.removed',
  targetType: CATALOG_SAVED_FILTER_TARGET,
  actors: ['authenticated'],
  before: { listKey: savedFilterList, visibility: savedFilterVisibility },
  after: { ownedByActor: auditField.boolean() },
});

/** The audit target type of an attribute definition (attributes plan, package A2). */
export const CATALOG_ATTRIBUTE_DEFINITION_TARGET = 'catalog.attribute-definition';

const definitionStatus = auditField.enumOf(['draft', 'active', 'archived'] as const);

/** What the audit keeps of a definition's revision: flags and counts, never a name or a label. */
const definitionShape = {
  status: definitionStatus,
  revisionNo: auditField.integer(),
  material: auditField.boolean(),
  isVariantOption: auditField.boolean(),
  optionCount: auditField.integer(),
  activeOptionCount: auditField.integer(),
};

/** An admin created a definition as a draft (A2). */
export const AttributeDefinitionCreatedAudit = defineAuditAction({
  action: 'catalog.attribute-definition.created',
  targetType: CATALOG_ATTRIBUTE_DEFINITION_TARGET,
  actors: ['authenticated'],
  after: definitionShape,
});

/**
 * An admin saved a new revision of a definition (A2; catalog design 8.2). The flags before and
 * after show a change of `material` or of the variant flag. Clearing `material` on a published
 * definition is not an edit: it is the confirm of a two-person request, and then the row names the
 * request and its requester; the actor is the confirming admin, so both account ids are here.
 */
export const AttributeDefinitionRevisedAudit = defineAuditAction({
  action: 'catalog.attribute-definition.revised',
  targetType: CATALOG_ATTRIBUTE_DEFINITION_TARGET,
  actors: ['authenticated'],
  before: definitionShape,
  after: {
    ...definitionShape,
    relaxationRequestId: auditField.optional(auditField.id()),
    requestedByAccountId: auditField.optional(auditField.id()),
  },
});

/** An admin published a draft definition: sellers now see it where a feature set names it. */
export const AttributeDefinitionPublishedAudit = defineAuditAction({
  action: 'catalog.attribute-definition.published',
  targetType: CATALOG_ATTRIBUTE_DEFINITION_TARGET,
  actors: ['authenticated'],
  before: { status: auditField.enumOf(['draft'] as const) },
  after: definitionShape,
});

/** An admin set aside a draft that was never published; it is archived, never deleted. */
export const AttributeDefinitionDiscardedAudit = defineAuditAction({
  action: 'catalog.attribute-definition.discarded',
  targetType: CATALOG_ATTRIBUTE_DEFINITION_TARGET,
  actors: ['authenticated'],
  before: { status: auditField.enumOf(['draft'] as const) },
  after: { status: auditField.enumOf(['archived'] as const) },
});

/**
 * An admin merged one value of a select attribute into another (A8; plan ت۶). Counts only: no
 * label and no value code (the audit vocabulary has no free-text field). `mergedValueCount` is how
 * many values of the new revision point at another value.
 */
export const AttributeValuesMergedAudit = defineAuditAction({
  action: 'catalog.attribute-definition.values-merged',
  targetType: CATALOG_ATTRIBUTE_DEFINITION_TARGET,
  actors: ['authenticated'],
  before: definitionShape,
  after: {
    ...definitionShape,
    mergedValueCount: auditField.integer(),
  },
});

/**
 * An admin archived a published attribute (A8). For a `material` one the actor is the confirming
 * admin and the row names the request and its requester, as the revision that clears `material`.
 */
export const AttributeDefinitionArchivedAudit = defineAuditAction({
  action: 'catalog.attribute-definition.archived',
  targetType: CATALOG_ATTRIBUTE_DEFINITION_TARGET,
  actors: ['authenticated'],
  before: { status: auditField.enumOf(['active'] as const), material: auditField.boolean() },
  after: {
    status: auditField.enumOf(['archived'] as const),
    relaxationRequestId: auditField.optional(auditField.id()),
    requestedByAccountId: auditField.optional(auditField.id()),
  },
});

/**
 * An admin merged an attribute into another (A8): the source is archived and points at the target.
 * `mappedValueCount` is how many of its values were mapped to a value of the target.
 */
export const AttributeDefinitionsMergedAudit = defineAuditAction({
  action: 'catalog.attribute-definition.merged',
  targetType: CATALOG_ATTRIBUTE_DEFINITION_TARGET,
  actors: ['authenticated'],
  before: { status: auditField.enumOf(['active'] as const), material: auditField.boolean() },
  after: {
    status: auditField.enumOf(['archived'] as const),
    mergedIntoId: auditField.id(),
    mappedValueCount: auditField.integer(),
  },
});

const relaxationKind = auditField.enumOf([
  'clear-material',
  'archive',
  'remove-from-family',
] as const);

/**
 * An admin asked to relax a `material` attribute (catalog design 8.2): a different admin must
 * confirm before `expiresAt`. The target is the definition.
 */
export const AttributeRelaxationRequestedAudit = defineAuditAction({
  action: 'catalog.attribute-relaxation.requested',
  targetType: CATALOG_ATTRIBUTE_DEFINITION_TARGET,
  actors: ['authenticated'],
  after: {
    requestId: auditField.id(),
    kind: relaxationKind,
    definitionVersion: auditField.integer(),
    expiresAt: auditField.instant(),
  },
});

/**
 * A relaxation request was cancelled: by its requester, or because the definition was revised
 * while it was open (Q-K14; the actor is then the admin who saved that revision).
 */
export const AttributeRelaxationCancelledAudit = defineAuditAction({
  action: 'catalog.attribute-relaxation.cancelled',
  targetType: CATALOG_ATTRIBUTE_DEFINITION_TARGET,
  actors: ['authenticated'],
  after: {
    requestId: auditField.id(),
    reason: auditField.enumOf(['requester', 'definition-changed'] as const),
    requestedByAccountId: auditField.id(),
  },
});

/**
 * A relaxation request ran out of time unconfirmed: closed by the expiry job (system), or by the
 * unit of a new request for the same attribute (the admin asking again).
 */
export const AttributeRelaxationExpiredAudit = defineAuditAction({
  action: 'catalog.attribute-relaxation.expired',
  targetType: CATALOG_ATTRIBUTE_DEFINITION_TARGET,
  actors: ['authenticated', 'system'],
  after: { requestId: auditField.id(), requestedByAccountId: auditField.id() },
});

/** The audit target type of a platform category (categories package C3a). */
export const CATALOG_PLATFORM_CATEGORY_TARGET = 'catalog.platform-category';

const categoryEditStatus = auditField.enumOf(['active', 'hidden', 'archived'] as const);

/**
 * The audit target type of a category tree import (categories package C7a). The target id is
 * derived from the file's SHA-256 (see `importFileTargetId`), because the audit vocabulary has no
 * text field and the file hash is what the entry must carry.
 */
export const CATALOG_CATEGORY_TREE_IMPORT_TARGET = 'catalog.category-tree-import';

/**
 * An admin applied a category tree import file: counts and the format only. The file's SHA-256 is
 * the target id (its first 122 bits in a UUID v7 layout). No cell, name or slug is recorded; each
 * created or changed category has its own audit entry from the editor's use cases.
 */
export const CategoryTreeImportedAudit = defineAuditAction({
  action: 'catalog.category-tree.imported',
  targetType: CATALOG_CATEGORY_TREE_IMPORT_TARGET,
  actors: ['authenticated'],
  after: {
    format: auditField.enumOf(['csv', 'xlsx'] as const),
    rows: auditField.integer(),
    created: auditField.integer(),
    updated: auditField.integer(),
    unchanged: auditField.integer(),
    treeVersion: auditField.integer(),
  },
});

/** An admin added a category; it starts hidden (plan decision 5). Counts and flags only: no name, no slug. */
export const PlatformCategoryCreatedAudit = defineAuditAction({
  action: 'catalog.platform-category.created',
  targetType: CATALOG_PLATFORM_CATEGORY_TARGET,
  actors: ['authenticated'],
  after: {
    status: categoryEditStatus,
    level: auditField.integer(),
    localeCount: auditField.integer(),
  },
});

/** An admin saved the details of a category (names, descriptions, keywords, search-result fields, menu flag). */
export const PlatformCategoryDetailsChangedAudit = defineAuditAction({
  action: 'catalog.platform-category.details-changed',
  targetType: CATALOG_PLATFORM_CATEGORY_TARGET,
  actors: ['authenticated'],
  // Flags and counts only (review amendment): whether a search-result title or description is
  // set, never its text.
  before: {
    revisionNo: auditField.integer(),
    localeCount: auditField.integer(),
    showInMenu: auditField.boolean(),
    noindex: auditField.boolean(),
    seoTitleSet: auditField.boolean(),
    seoDescriptionSet: auditField.boolean(),
  },
  after: {
    revisionNo: auditField.integer(),
    localeCount: auditField.integer(),
    showInMenu: auditField.boolean(),
    noindex: auditField.boolean(),
    seoTitleSet: auditField.boolean(),
    seoDescriptionSet: auditField.boolean(),
  },
});

/** An admin moved a category up or down among its siblings. */
export const PlatformCategoryReorderedAudit = defineAuditAction({
  action: 'catalog.platform-category.reordered',
  targetType: CATALOG_PLATFORM_CATEGORY_TARGET,
  actors: ['authenticated'],
  before: { position: auditField.integer() },
  after: { position: auditField.integer() },
});

/** An admin hid a category; `cascaded` counts the descendants hidden with it. */
export const PlatformCategoryHiddenAudit = defineAuditAction({
  action: 'catalog.platform-category.hidden',
  targetType: CATALOG_PLATFORM_CATEGORY_TARGET,
  actors: ['authenticated'],
  before: { status: categoryEditStatus },
  after: { status: categoryEditStatus, cascaded: auditField.integer() },
});

/** An admin showed a category; `restored` counts the descendants shown again with it. */
export const PlatformCategoryShownAudit = defineAuditAction({
  action: 'catalog.platform-category.shown',
  targetType: CATALOG_PLATFORM_CATEGORY_TARGET,
  actors: ['authenticated'],
  before: { status: categoryEditStatus },
  after: { status: categoryEditStatus, restored: auditField.integer() },
});

/** An admin changed the URL name of a category; the old one redirects (the slug itself is not audited). */
export const PlatformCategorySlugChangedAudit = defineAuditAction({
  action: 'catalog.platform-category.slug-changed',
  targetType: CATALOG_PLATFORM_CATEGORY_TARGET,
  actors: ['authenticated'],
  before: { revisionNo: auditField.integer() },
  after: { revisionNo: auditField.integer() },
});

/** An admin discarded a category that was never shown (archived, never deleted). */
export const PlatformCategoryDiscardedAudit = defineAuditAction({
  action: 'catalog.platform-category.discarded',
  targetType: CATALOG_PLATFORM_CATEGORY_TARGET,
  actors: ['authenticated'],
  before: { status: categoryEditStatus },
  after: { status: categoryEditStatus },
});

/**
 * An admin set, replaced or removed the image of a category (categories package C3c). The ids
 * only: the picture itself is never in the audit log. `imageId` is absent when there is none.
 */
export const PlatformCategoryImageChangedAudit = defineAuditAction({
  action: 'catalog.platform-category.image-changed',
  targetType: CATALOG_PLATFORM_CATEGORY_TARGET,
  actors: ['authenticated'],
  before: { imageId: auditField.optional(auditField.id()) },
  after: { imageId: auditField.optional(auditField.id()) },
});

/**
 * An admin moved a category with its subtree under a new parent (categories C4a; catalog design
 * 4.6, C-8: every move is an audited entry path). Ids, levels and counts only; the reason note is
 * on the category revision (`reasonGiven`), never here.
 */
export const PlatformCategoryMovedAudit = defineAuditAction({
  action: 'catalog.platform-category.moved',
  targetType: CATALOG_PLATFORM_CATEGORY_TARGET,
  actors: ['authenticated'],
  before: { parentId: auditField.optional(auditField.id()), level: auditField.integer() },
  after: {
    parentId: auditField.optional(auditField.id()),
    level: auditField.integer(),
    subtreeSize: auditField.integer(),
    tagsMarked: auditField.integer(),
    reasonGiven: auditField.boolean(),
  },
});

/** An admin merged a category into another; its children moved there (C4a). */
export const PlatformCategoryMergedAudit = defineAuditAction({
  action: 'catalog.platform-category.merged',
  targetType: CATALOG_PLATFORM_CATEGORY_TARGET,
  actors: ['authenticated'],
  before: { status: categoryEditStatus },
  after: {
    mergedIntoId: auditField.id(),
    childrenMoved: auditField.integer(),
    activitiesRelinked: auditField.integer(),
    tagsMarked: auditField.integer(),
    reasonGiven: auditField.boolean(),
  },
});

/** An admin archived a category (terminal, plan decision 7) (C4a). */
export const PlatformCategoryArchivedAudit = defineAuditAction({
  action: 'catalog.platform-category.archived',
  targetType: CATALOG_PLATFORM_CATEGORY_TARGET,
  actors: ['authenticated'],
  before: { status: categoryEditStatus },
  after: {
    status: categoryEditStatus,
    activitiesUnlinked: auditField.integer(),
    tagsMarked: auditField.integer(),
    reasonGiven: auditField.boolean(),
  },
});

/** The audit target type of a culture (multi-culture package 1; ADR-0047). */
export const CATALOG_CULTURE_TARGET = 'catalog.culture';

const cultureStatus = auditField.enumOf(['draft', 'active', 'inactive'] as const);
/** `inherit` is a mark left to the nearest ancestor (or the default, "required"). */
const cultureMark = auditField.enumOf(['required', 'neutral', 'inherit'] as const);
const cultureVisible = auditField.enumOf(['shown', 'hidden', 'inherit'] as const);
/** A row's `visible` as the audit keeps it (null = inherit; ADR-0048 security review M2). */
export const cultureVisibleOf = (visible: boolean | null): 'shown' | 'hidden' | 'inherit' =>
  visible === null ? 'inherit' : visible ? 'shown' : 'hidden';

/** An admin defined a culture (a draft). Whether it names a required certification type, never the text. */
export const CultureCreatedAudit = defineAuditAction({
  action: 'catalog.culture.created',
  targetType: CATALOG_CULTURE_TARGET,
  actors: ['authenticated'],
  after: { status: cultureStatus, requiresCertification: auditField.boolean() },
});

/**
 * An admin edited a culture. Which parts changed, never the text. The required certification type
 * decides which Offers a certified culture shows (ADR-0047 decision 12), so a change of it and a
 * change of the default are recorded as their own flags.
 */
export const CultureEditedAudit = defineAuditAction({
  action: 'catalog.culture.edited',
  targetType: CATALOG_CULTURE_TARGET,
  actors: ['authenticated'],
  before: {
    status: cultureStatus,
    isDefault: auditField.boolean(),
    requiresCertification: auditField.boolean(),
  },
  after: {
    status: cultureStatus,
    isDefault: auditField.boolean(),
    requiresCertification: auditField.boolean(),
    namesChanged: auditField.boolean(),
    orderChanged: auditField.boolean(),
    badgeChanged: auditField.boolean(),
    requiredCertificationTypeChanged: auditField.boolean(),
  },
});

/** An admin set or cleared a culture's mark on a category branch (visibility and certification mark). */
export const CultureCategoryMarkChangedAudit = defineAuditAction({
  action: 'catalog.culture.category-mark-changed',
  targetType: CATALOG_CULTURE_TARGET,
  actors: ['authenticated'],
  before: {
    categoryId: auditField.id(),
    hadRow: auditField.boolean(),
    visible: cultureVisible,
    certificationMark: cultureMark,
  },
  after: {
    categoryId: auditField.id(),
    hasRow: auditField.boolean(),
    visible: cultureVisible,
    certificationMark: cultureMark,
  },
});

/** The audit target type of a brand (catalog brand package; attributes package A5). */
export const CATALOG_BRAND_TARGET = 'catalog.brand';

const brandStatus = auditField.enumOf(['draft', 'active', 'archived'] as const);
const brandOrigin = auditField.enumOf(['admin', 'seller'] as const);

/** An admin created an active brand. Ids, the origin and a status only: never the name. */
export const BrandCreatedAudit = defineAuditAction({
  action: 'catalog.brand.created',
  targetType: CATALOG_BRAND_TARGET,
  actors: ['authenticated'],
  after: { status: brandStatus, origin: brandOrigin },
});

/** A seller proposed a brand; it is a draft until an admin approves it. */
export const BrandProposedAudit = defineAuditAction({
  action: 'catalog.brand.proposed',
  targetType: CATALOG_BRAND_TARGET,
  actors: ['authenticated'],
  after: { status: brandStatus, origin: brandOrigin },
});

/** An admin replaced the content of a brand; which parts changed, never the text. */
export const BrandEditedAudit = defineAuditAction({
  action: 'catalog.brand.edited',
  targetType: CATALOG_BRAND_TARGET,
  actors: ['authenticated'],
  before: { status: brandStatus },
  after: {
    status: brandStatus,
    nameChanged: auditField.boolean(),
    slugChanged: auditField.boolean(),
    summaryChanged: auditField.boolean(),
    originCountryChanged: auditField.boolean(),
    imagesChanged: auditField.boolean(),
  },
});

/** An admin approved a draft brand, normally a seller's proposal. */
export const BrandApprovedAudit = defineAuditAction({
  action: 'catalog.brand.approved',
  targetType: CATALOG_BRAND_TARGET,
  actors: ['authenticated'],
  before: { status: auditField.enumOf(['draft'] as const) },
  after: { status: auditField.enumOf(['active'] as const), proposedBySeller: auditField.boolean() },
});

/** An admin archived a brand; it keeps its row, slug and aliases. */
export const BrandArchivedAudit = defineAuditAction({
  action: 'catalog.brand.archived',
  targetType: CATALOG_BRAND_TARGET,
  actors: ['authenticated'],
  before: { status: brandStatus },
  after: { status: auditField.enumOf(['archived'] as const) },
});

/**
 * An admin merged brands into this one (the target). Counts only: how many brands, how many
 * products moved and how many spellings were added.
 */
export const BrandMergedAudit = defineAuditAction({
  action: 'catalog.brand.merged',
  targetType: CATALOG_BRAND_TARGET,
  actors: ['authenticated'],
  after: {
    sourceCount: auditField.integer(),
    productsMoved: auditField.integer(),
    aliasesAdded: auditField.integer(),
  },
});

/** An admin decided that the brands of a merge-queue group are different brands. One row per brand. */
export const BrandMergeDismissedAudit = defineAuditAction({
  action: 'catalog.brand.merge-dismissed',
  targetType: CATALOG_BRAND_TARGET,
  actors: ['authenticated'],
  after: { groupSize: auditField.integer() },
});

/** The audit target type of a feature set, stored as an attribute family (package A4). */
export const CATALOG_ATTRIBUTE_FAMILY_TARGET = 'catalog.attribute-family';

/** What the audit keeps of a feature set revision: counts, never a name. */
const familyShape = {
  revisionNo: auditField.integer(),
  groupCount: auditField.integer(),
  attributeCount: auditField.integer(),
  requiredCount: auditField.integer(),
  recommendedCount: auditField.integer(),
  optionalCount: auditField.integer(),
};

/** An admin created a feature set (A4). */
export const AttributeFamilyCreatedAudit = defineAuditAction({
  action: 'catalog.attribute-family.created',
  targetType: CATALOG_ATTRIBUTE_FAMILY_TARGET,
  actors: ['authenticated'],
  after: familyShape,
});

/**
 * An admin saved a new revision of a feature set (A4; catalog design 8.2). `requiredRelaxed`
 * counts the fields that were required and no longer are, dropped or lowered: a relaxation the
 * audit must show. Removing a `material` attribute is not an edit (it needs the two-person
 * request), so it never reaches this row.
 */
export const AttributeFamilyRevisedAudit = defineAuditAction({
  action: 'catalog.attribute-family.revised',
  targetType: CATALOG_ATTRIBUTE_FAMILY_TARGET,
  actors: ['authenticated'],
  before: familyShape,
  after: { ...familyShape, requiredRelaxed: auditField.integer() },
});

/** The audit target type of an attribute import run (attributes package A9). */
export const CATALOG_ATTRIBUTE_IMPORT_TARGET = 'catalog.attribute-import';

/**
 * An admin ran an attribute or value import (A9) after its diff preview. One row per run, written
 * after the rows were applied through the editor use cases (each of which also wrote its own
 * `catalog.attribute-definition.*` row). The target is an id made for the run. Counts and the file
 * kind only: the audit vocabulary has no text field, so no code, name or label of the file is here.
 */
export const AttributeImportRanAudit = defineAuditAction({
  action: 'catalog.attribute-import.ran',
  targetType: CATALOG_ATTRIBUTE_IMPORT_TARGET,
  actors: ['authenticated'],
  after: {
    kind: auditField.enumOf(['attributes', 'values'] as const),
    skipErrors: auditField.boolean(),
    rows: auditField.integer(),
    created: auditField.integer(),
    updated: auditField.integer(),
    unchanged: auditField.integer(),
    failed: auditField.integer(),
    skipped: auditField.integer(),
  },
});

/** The audit target type of a seller's value suggestion (attributes plan, package A5). */
export const CATALOG_ATTRIBUTE_SUGGESTION_TARGET = 'catalog.attribute-value-suggestion';

/** A seller suggested a new value for a select attribute. Ids only: never the text they typed. */
export const AttributeValueSuggestedAudit = defineAuditAction({
  action: 'catalog.attribute-value-suggestion.suggested',
  targetType: CATALOG_ATTRIBUTE_SUGGESTION_TARGET,
  actors: ['authenticated'],
  after: { definitionId: auditField.id(), productId: auditField.id() },
});

/**
 * An admin approved (a value was added: its revision is audited as
 * `catalog.attribute-definition.revised`), mapped or rejected a suggestion. Neither the seller's
 * text, the value's labels nor the reason is kept here.
 */
export const AttributeValueSuggestionDecidedAudit = defineAuditAction({
  action: 'catalog.attribute-value-suggestion.decided',
  targetType: CATALOG_ATTRIBUTE_SUGGESTION_TARGET,
  actors: ['authenticated'],
  before: { status: auditField.enumOf(['open'] as const) },
  after: {
    status: auditField.enumOf(['approved', 'mapped', 'rejected'] as const),
    definitionId: auditField.id(),
    sellerId: auditField.id(),
  },
});

/** The audit target type of a seller's tag suggestion (product tags package T5). */
export const CATALOG_TOPIC_SUGGESTION_TARGET = 'catalog.topic-suggestion';

/** A seller suggested a new tag. Ids only: never the text they typed. */
export const TopicSuggestedAudit = defineAuditAction({
  action: 'catalog.topic-suggestion.suggested',
  targetType: CATALOG_TOPIC_SUGGESTION_TARGET,
  actors: ['authenticated'],
  after: { productId: auditField.id() },
});

/**
 * An admin approved (a topic was created from it), mapped or rejected a tag suggestion. Neither
 * the seller's text nor the reason is kept here.
 */
export const TopicSuggestionDecidedAudit = defineAuditAction({
  action: 'catalog.topic-suggestion.decided',
  targetType: CATALOG_TOPIC_SUGGESTION_TARGET,
  actors: ['authenticated'],
  before: { status: auditField.enumOf(['open'] as const) },
  after: {
    status: auditField.enumOf(['approved', 'mapped', 'rejected'] as const),
    topicId: auditField.optional(auditField.id()),
    sellerId: auditField.id(),
  },
});

/** The audit target type of a category's attribute links (A4, categories C8). */
export const CATALOG_CATEGORY_LINKS_TARGET = 'catalog.category';

/** What the audit keeps of a category's links: counts and a flag, never a code or a name. */
const linkShape = {
  revisionNo: auditField.integer(),
  hasFeatureSet: auditField.boolean(),
  filterCount: auditField.integer(),
};

/**
 * An admin changed the feature set or the filter list a category holds (A4). The first link of a
 * category is recorded with `revisionNo` 0 before it.
 */
export const CategoryAttributesChangedAudit = defineAuditAction({
  action: 'catalog.category-attributes.changed',
  targetType: CATALOG_CATEGORY_LINKS_TARGET,
  actors: ['authenticated'],
  before: linkShape,
  after: linkShape,
});

/** The audit target type of a variant type's display settings (variants V6): the definition. */
export const CATALOG_VARIANT_TYPE_TARGET = 'catalog.variant-type';

/** What the audit keeps of variant type settings: codes and counts, never a colour or a text. */
const variantTypeShape = {
  revisionNo: auditField.integer(),
  displayStyle: auditField.enumOf(['buttons', 'swatches', 'dropdown'] as const),
  optionOrder: auditField.enumOf(['manual', 'alphabetical', 'by-size'] as const),
  swatchCount: auditField.integer(),
  sellerHelpCount: auditField.integer(),
};

/**
 * An admin changed how buyers choose a variant type (variants V6). `before` is the stored settings
 * or the defaults (revision 0) when none were stored.
 */
export const VariantTypeSettingsChangedAudit = defineAuditAction({
  action: 'catalog.variant-type.settings-changed',
  targetType: CATALOG_VARIANT_TYPE_TARGET,
  actors: ['authenticated'],
  before: variantTypeShape,
  after: variantTypeShape,
});

/** The audit target types of seller category proposals and shelves (categories C9a). */
export const CATALOG_CATEGORY_PROPOSAL_TARGET = 'catalog.category-proposal';
export const CATALOG_SELLER_CATEGORY_TARGET = 'catalog.seller-category';

/** A seller proposed a shelf under a platform category. Ids and a count, never the names. */
export const CategoryProposedAudit = defineAuditAction({
  action: 'catalog.category-proposal.proposed',
  targetType: CATALOG_CATEGORY_PROPOSAL_TARGET,
  actors: ['authenticated'],
  after: { parentId: auditField.id(), localeCount: auditField.integer() },
});

/** An admin approved a proposal: the shelf it created. Ids only, never the names. */
export const CategoryProposalApprovedAudit = defineAuditAction({
  action: 'catalog.category-proposal.approved',
  targetType: CATALOG_CATEGORY_PROPOSAL_TARGET,
  actors: ['authenticated'],
  after: { sellerId: auditField.id(), sellerCategoryId: auditField.id() },
});

/** An admin rejected a proposal with a prepared reason (a code, never text). */
export const CategoryProposalRejectedAudit = defineAuditAction({
  action: 'catalog.category-proposal.rejected',
  targetType: CATALOG_CATEGORY_PROPOSAL_TARGET,
  actors: ['authenticated'],
  after: {
    sellerId: auditField.id(),
    reasonCode: auditField.enumOf([
      'already-exists',
      'too-narrow',
      'too-broad',
      'misleading',
      'not-sold-here',
      'other',
    ] as const),
  },
});

/** A proposal was cancelled by the seller, or by the system when SEL-26 was switched off. */
export const CategoryProposalCancelledAudit = defineAuditAction({
  action: 'catalog.category-proposal.cancelled',
  targetType: CATALOG_CATEGORY_PROPOSAL_TARGET,
  actors: ['authenticated', 'system'],
  after: {
    sellerId: auditField.id(),
    reasonCode: auditField.enumOf(['seller-cancelled', 'permission-revoked'] as const),
  },
});

/** An admin promoted a shelf into the platform tree (same id, created hidden). */
export const SellerCategoryPromotedAudit = defineAuditAction({
  action: 'catalog.seller-category.promoted',
  targetType: CATALOG_SELLER_CATEGORY_TARGET,
  actors: ['authenticated'],
  after: {
    sellerId: auditField.id(),
    parentId: auditField.id(),
    level: auditField.integer(),
    offersCleared: auditField.integer(),
  },
});

/** An admin merged a shelf into a platform category; the shelf left the seller's Offers. */
export const SellerCategoryMergedAudit = defineAuditAction({
  action: 'catalog.seller-category.merged',
  targetType: CATALOG_SELLER_CATEGORY_TARGET,
  actors: ['authenticated'],
  after: {
    sellerId: auditField.id(),
    categoryId: auditField.id(),
    offersCleared: auditField.integer(),
  },
});

export const CATALOG_AUDIT_ACTIONS = [
  ProductPausedAudit,
  ProductResumedAudit,
  ProductWithdrawnAudit,
  ProductRetiredAudit,
  ProductTypeChangedAudit,
  PlatformImportStartedAudit,
  OwnImportStartedAudit,
  SavedFilterSharedAudit,
  SavedFilterChangedAudit,
  SavedFilterRemovedAudit,
  AttributeDefinitionCreatedAudit,
  AttributeDefinitionRevisedAudit,
  AttributeDefinitionPublishedAudit,
  AttributeDefinitionDiscardedAudit,
  AttributeValuesMergedAudit,
  AttributeDefinitionArchivedAudit,
  AttributeDefinitionsMergedAudit,
  AttributeRelaxationRequestedAudit,
  AttributeRelaxationCancelledAudit,
  AttributeRelaxationExpiredAudit,
  CategoryTreeImportedAudit,
  PlatformCategoryCreatedAudit,
  PlatformCategoryDetailsChangedAudit,
  PlatformCategoryReorderedAudit,
  PlatformCategoryHiddenAudit,
  PlatformCategoryShownAudit,
  PlatformCategorySlugChangedAudit,
  PlatformCategoryDiscardedAudit,
  PlatformCategoryImageChangedAudit,
  ProductImageDeletedAudit,
  PlatformCategoryMovedAudit,
  PlatformCategoryMergedAudit,
  PlatformCategoryArchivedAudit,
  BrandCreatedAudit,
  BrandProposedAudit,
  BrandEditedAudit,
  CultureCreatedAudit,
  CultureEditedAudit,
  CultureCategoryMarkChangedAudit,
  BrandApprovedAudit,
  BrandArchivedAudit,
  BrandMergedAudit,
  BrandMergeDismissedAudit,
  AttributeFamilyCreatedAudit,
  AttributeFamilyRevisedAudit,
  AttributeImportRanAudit,
  AttributeValueSuggestedAudit,
  AttributeValueSuggestionDecidedAudit,
  TopicSuggestedAudit,
  TopicSuggestionDecidedAudit,
  CategoryAttributesChangedAudit,
  VariantTypeSettingsChangedAudit,
  CategoryProposedAudit,
  CategoryProposalApprovedAudit,
  CategoryProposalRejectedAudit,
  CategoryProposalCancelledAudit,
  SellerCategoryPromotedAudit,
  SellerCategoryMergedAudit,
] as const;
