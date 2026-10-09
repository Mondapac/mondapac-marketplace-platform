import type { AttributeDefinitionState, AttributeOption } from './attribute-definition';
import type { OfferState } from './offer';
import type { CategoryName, PlatformCategoryState } from './platform-category';
import type { RevisionContent, RevisionText, RevisionVariantContent } from './revision-content';

/**
 * The claim-checked fields (catalog design 6.2, AC 21): every customer- or search-visible text
 * field of the content types that exist today, and the default-deny that keeps it complete. A
 * field id names a place a claim text can sit; the matcher is called on exactly these.
 *
 * Fields of a later slice (image alt text, URL key, seller category names and
 * descriptions, proposal texts, SEO and brand fields) join this list in the slice that adds the
 * content type, in the same change as the type.
 */
export const CLAIM_CHECKED_FIELD_IDS = [
  'attribute-definition.name',
  'attribute-definition.option-label',
  'offer.description',
  'platform-category.name',
  'platform-category.slug',
  'product.attribute-text-value',
  'product.description',
  'product.name',
  'product.short-description',
  'product.variant-label',
] as const;
export type ClaimCheckedFieldId = (typeof CLAIM_CHECKED_FIELD_IDS)[number];

export function isClaimCheckedFieldId(value: unknown): value is ClaimCheckedFieldId {
  return (
    typeof value === 'string' && (CLAIM_CHECKED_FIELD_IDS as readonly string[]).includes(value)
  );
}

/** Why a field is not matched: it holds no seller- or admin-written text a customer reads. */
export type ExemptReason = 'identifier' | 'internal-code' | 'number' | 'timestamp' | 'reference';

/**
 * What a content type's key is: a checked text field, an exempt one with its reason, or a nested
 * content type that has its own table below.
 */
export type FieldDisposition =
  | { readonly checked: ClaimCheckedFieldId }
  | { readonly exempt: ExemptReason }
  | { readonly nested: string };

const exempt = (reason: ExemptReason): FieldDisposition => ({ exempt: reason });
const checked = (field: ClaimCheckedFieldId): FieldDisposition => ({ checked: field });
const nested = (table: string): FieldDisposition => ({ nested: table });

// Each table is a `Record` over the keys of its content type, so a new key is a compile error
// until it is classified here: a field is checked by default or named exempt by a person.

export const REVISION_TEXT_FIELDS: Record<keyof RevisionText, FieldDisposition> = {
  name: checked('product.name'),
  shortDescription: checked('product.short-description'),
  description: checked('product.description'),
};

export const REVISION_VARIANT_FIELDS: Record<keyof RevisionVariantContent, FieldDisposition> = {
  variantId: exempt('identifier'),
  position: exempt('number'),
  optionKey: exempt('internal-code'),
  // Attribute code to option code: the codes are internal, the labels live on the definition.
  optionValues: exempt('internal-code'),
  labels: checked('product.variant-label'),
};

export const REVISION_CONTENT_FIELDS: Record<keyof RevisionContent, FieldDisposition> = {
  texts: nested('REVISION_TEXT_FIELDS'),
  categoryIds: exempt('reference'),
  taxCategoryCode: exempt('internal-code'),
  attributeValues: checked('product.attribute-text-value'),
  variants: nested('REVISION_VARIANT_FIELDS'),
  imageIds: exempt('reference'),
  schemaRef: exempt('reference'),
  contentSchemaVersion: exempt('number'),
};

export const ATTRIBUTE_OPTION_FIELDS: Record<keyof AttributeOption, FieldDisposition> = {
  code: exempt('internal-code'),
  labels: checked('attribute-definition.option-label'),
  active: exempt('internal-code'),
  position: exempt('number'),
};

export const ATTRIBUTE_DEFINITION_FIELDS: Record<keyof AttributeDefinitionState, FieldDisposition> =
  {
    id: exempt('identifier'),
    marketId: exempt('identifier'),
    code: exempt('internal-code'),
    dataType: exempt('internal-code'),
    localizable: exempt('internal-code'),
    status: exempt('internal-code'),
    createdByKind: exempt('internal-code'),
    revisionId: exempt('identifier'),
    revisionNo: exempt('number'),
    material: exempt('internal-code'),
    isVariantOption: exempt('internal-code'),
    bounds: exempt('number'),
    names: checked('attribute-definition.name'),
    options: nested('ATTRIBUTE_OPTION_FIELDS'),
    version: exempt('number'),
    createdAt: exempt('timestamp'),
  };

export const CATEGORY_NAME_FIELDS: Record<keyof CategoryName, FieldDisposition> = {
  locale: exempt('internal-code'),
  name: checked('platform-category.name'),
};

export const PLATFORM_CATEGORY_FIELDS: Record<keyof PlatformCategoryState, FieldDisposition> = {
  id: exempt('identifier'),
  marketId: exempt('identifier'),
  parentId: exempt('reference'),
  verticalRootCode: exempt('internal-code'),
  // The slug is shown in the address, so it is a customer-visible text.
  slug: checked('platform-category.slug'),
  status: exempt('internal-code'),
  createdByKind: exempt('internal-code'),
  revisionId: exempt('identifier'),
  revisionNo: exempt('number'),
  names: nested('CATEGORY_NAME_FIELDS'),
  version: exempt('number'),
  createdAt: exempt('timestamp'),
};

export const OFFER_FIELDS: Record<keyof OfferState, FieldDisposition> = {
  id: exempt('identifier'),
  marketId: exempt('identifier'),
  sellerId: exempt('identifier'),
  productId: exempt('identifier'),
  // A seller's own code, shown to the seller only (CAT-10); a customer never reads it.
  sellerSku: exempt('internal-code'),
  conditionCode: exempt('internal-code'),
  // Locale to text, written by the seller and read by customers.
  description: checked('offer.description'),
  handling: exempt('internal-code'),
  attestationRecordedAt: exempt('timestamp'),
  attestationAccountId: exempt('identifier'),
  status: exempt('internal-code'),
  offSaleCauses: exempt('internal-code'),
  listed: exempt('internal-code'),
  submittedAt: exempt('timestamp'),
  firstPublishedAt: exempt('timestamp'),
  deletedAt: exempt('timestamp'),
  version: exempt('number'),
  createdAt: exempt('timestamp'),
};

/** Every table above by name, so the schema test can walk them and follow `nested`. */
export const FIELD_TABLES: Readonly<Record<string, Readonly<Record<string, FieldDisposition>>>> = {
  REVISION_TEXT_FIELDS,
  REVISION_VARIANT_FIELDS,
  REVISION_CONTENT_FIELDS,
  ATTRIBUTE_OPTION_FIELDS,
  ATTRIBUTE_DEFINITION_FIELDS,
  CATEGORY_NAME_FIELDS,
  PLATFORM_CATEGORY_FIELDS,
  OFFER_FIELDS,
};

/**
 * Every exported content type of `domain/` and `contracts/`, classified: it has a field table
 * above, or it holds no text a customer reads (with the reason). A spec scans the sources for
 * exported interfaces and fails on one that is missing here, so a new content type cannot arrive
 * unclassified (AC 21, design 6.2). Codes of families, groups and attributes are internal: no
 * page shows them and none is put in an address.
 */
export const CONTENT_TYPE_CLASSIFICATION: Readonly<
  Record<string, { readonly table: string } | { readonly noCustomerText: string }>
> = {
  AttributeDefinition: { noCustomerText: 'aggregate class around AttributeDefinitionState' },
  AttributeFamily: { noCustomerText: 'aggregate class around AttributeFamilyState' },
  LocalizedText: { noCustomerText: 'carrier type; every use sits inside a classified type' },
  OfferMovedPayloadRefused: { noCustomerText: 'refusal code with fixed paths' },
  PlatformCategory: { noCustomerText: 'aggregate class around PlatformCategoryState' },
  Product: { noCustomerText: 'aggregate class around ProductState' },
  RateVerdict: { noCustomerText: 'numbers' },
  VariantValidationResult: { noCustomerText: 'issue codes with fixed paths' },
  AttributeBounds: { noCustomerText: 'numbers' },
  AttributeDefinitionState: { table: 'ATTRIBUTE_DEFINITION_FIELDS' },
  AttributeFamilyState: { noCustomerText: 'internal codes only; no name or label' },
  AttributeOption: { table: 'ATTRIBUTE_OPTION_FIELDS' },
  CatalogBatchTooLarge: { noCustomerText: 'refusal code' },
  CatalogFacade: { noCustomerText: 'interface of methods' },
  CatalogValidationFailed: { noCustomerText: 'refusal code with fixed paths' },
  Classification: { noCustomerText: 'sensitive-change verdict: codes and flags' },
  CategoryName: { table: 'CATEGORY_NAME_FIELDS' },
  DraftText: { noCustomerText: 'a text found in a draft, already named by its checked field id' },
  FamilyAttribute: { noCustomerText: 'internal code and flags' },
  FamilyGroup: { noCustomerText: 'internal code; the panel names a group by its own label key' },
  FreezeInput: { noCustomerText: 'working input of the freeze; its texts are checked as content' },
  FreezeIssue: { noCustomerText: 'issue code with a fixed path' },
  OutcomeInput: { noCustomerText: 'ids and a decision code' },
  Offer: { noCustomerText: 'aggregate class around OfferState' },
  OfferState: { table: 'OFFER_FIELDS' },
  OfferPendingHistory: { noCustomerText: 'history kind, field ids and an instant' },
  OfferSellUnits: { noCustomerText: 'sell units, numbers and ids' },
  PlatformCategoryState: { table: 'PLATFORM_CATEGORY_FIELDS' },
  ProductState: { noCustomerText: 'ids, codes, status and times; the texts are revision content' },
  ProductTypeHandler: { noCustomerText: 'interface of methods' },
  RateReservation: { noCustomerText: 'numbers and times' },
  RateLimit: { noCustomerText: 'numbers' },
  RevisionSummary: {
    noCustomerText: 'a comparison view of RevisionContent; its names are checked content',
  },
  RevisionContent: { table: 'REVISION_CONTENT_FIELDS' },
  RevisionText: { table: 'REVISION_TEXT_FIELDS' },
  RevisionVariantContent: { table: 'REVISION_VARIANT_FIELDS' },
  SellUnit: { noCustomerText: 'numbers and ids' },
  SensitiveChangesPolicy: { noCustomerText: 'flags per change kind' },
  StoredRevision: { noCustomerText: 'record around the content; the texts are RevisionContent' },
  VariantDraft: { noCustomerText: 'ids and option codes; labels are RevisionVariantContent' },
  VariantIssue: { noCustomerText: 'issue code with a fixed path' },
  VariantRecord: { noCustomerText: 'ids and times' },
  WorkingCopy: { noCustomerText: 'opaque draft; its texts are checked before any write (6.1)' },
};
