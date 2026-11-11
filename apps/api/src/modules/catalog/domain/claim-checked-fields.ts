import type {
  AttributeDefinitionState,
  AttributeDisplaySettings,
  AttributeOption,
} from './attribute-definition';
import type { AttributeFamilyState, FamilyAttribute, FamilyGroup } from './attribute-family';
import type { OfferState } from './offer';
import type { CategorySeo, CategoryText } from './category-edit';
import type { CategoryName, PlatformCategoryState } from './platform-category';
import type { RevisionContent, RevisionText, RevisionVariantContent } from './revision-content';
import type { TopicContent, TopicState, TopicTerm } from './topic';

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
  'attribute-definition.help-text',
  'attribute-definition.name',
  'attribute-definition.option-label',
  'feature-set.group-name',
  'feature-set.name',
  'offer.description',
  'platform-category.keyword',
  'platform-category.name',
  'platform-category.seo-description',
  'platform-category.seo-title',
  'platform-category.short-description',
  'platform-category.slug',
  'product.attribute-text-value',
  'product.description',
  'product.name',
  'product.short-description',
  'product.variant-label',
  'topic.intro',
  'topic.slug',
  'topic.term',
] as const;
export type ClaimCheckedFieldId = (typeof CLAIM_CHECKED_FIELD_IDS)[number];

export function isClaimCheckedFieldId(value: unknown): value is ClaimCheckedFieldId {
  return (
    typeof value === 'string' && (CLAIM_CHECKED_FIELD_IDS as readonly string[]).includes(value)
  );
}

/** Why a field is not matched: it holds no seller- or admin-written text a customer reads. */
export type ExemptReason =
  | 'identifier'
  | 'internal-code'
  | 'number'
  | 'timestamp'
  | 'reference'
  /** Read by administrators only (an internal note); never shown to a seller or a customer. */
  | 'admin-only';

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
  // Digits only (check digit validated at the freeze), a number, or ids of the revision's images.
  gtin: exempt('identifier'),
  shippingWeightGrams: exempt('number'),
  shippingLengthMm: exempt('number'),
  shippingWidthMm: exempt('number'),
  shippingHeightMm: exempt('number'),
  imageIds: exempt('reference'),
};

export const REVISION_CONTENT_FIELDS: Record<keyof RevisionContent, FieldDisposition> = {
  texts: nested('REVISION_TEXT_FIELDS'),
  categoryIds: exempt('reference'),
  // Ids of curated topics; the names were claim-checked when the admin wrote them (T1).
  topicIds: exempt('reference'),
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
  mergedInto: exempt('internal-code'),
};

export const ATTRIBUTE_DISPLAY_FIELDS: Record<keyof AttributeDisplaySettings, FieldDisposition> = {
  // Shown to sellers next to the field, so checked like the name (attributes A2).
  helpText: checked('attribute-definition.help-text'),
  showOnProductPage: exempt('internal-code'),
  searchable: exempt('internal-code'),
  canBeFilter: exempt('internal-code'),
  internalNote: exempt('admin-only'),
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
    display: nested('ATTRIBUTE_DISPLAY_FIELDS'),
    version: exempt('number'),
    createdAt: exempt('timestamp'),
    revisedAt: exempt('timestamp'),
  };

export const CATEGORY_NAME_FIELDS: Record<keyof CategoryName, FieldDisposition> = {
  locale: exempt('internal-code'),
  name: checked('platform-category.name'),
};

export const CATEGORY_TEXT_FIELDS: Record<keyof CategoryText, FieldDisposition> = {
  locale: exempt('internal-code'),
  name: checked('platform-category.name'),
  shortDescription: checked('platform-category.short-description'),
  keywords: checked('platform-category.keyword'),
};

export const CATEGORY_SEO_FIELDS: Record<keyof CategorySeo, FieldDisposition> = {
  title: checked('platform-category.seo-title'),
  description: checked('platform-category.seo-description'),
  noindex: exempt('internal-code'),
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

export const FAMILY_ATTRIBUTE_FIELDS: Record<keyof FamilyAttribute, FieldDisposition> = {
  code: exempt('internal-code'),
  required: exempt('internal-code'),
  isVariantOption: exempt('internal-code'),
  level: exempt('internal-code'),
};

export const FAMILY_GROUP_FIELDS: Record<keyof FamilyGroup, FieldDisposition> = {
  groupCode: exempt('internal-code'),
  // The group heading on the seller form (attributes A4), in every locale.
  names: checked('feature-set.group-name'),
  attributes: nested('FAMILY_ATTRIBUTE_FIELDS'),
};

export const FEATURE_SET_FIELDS: Record<keyof AttributeFamilyState, FieldDisposition> = {
  id: exempt('identifier'),
  marketId: exempt('identifier'),
  code: exempt('internal-code'),
  status: exempt('internal-code'),
  createdByKind: exempt('internal-code'),
  revisionId: exempt('identifier'),
  revisionNo: exempt('number'),
  // The feature set's name, shown to admins and in the seller form header (attributes A4).
  names: checked('feature-set.name'),
  groups: nested('FAMILY_GROUP_FIELDS'),
  version: exempt('number'),
  createdAt: exempt('timestamp'),
};

// Topics (product tags package T1): names, synonyms, the intro and the slug are read by buyers on
// the topic page and in search, so every one of them is claim-checked (john 24 Oct: claim words
// are refused). The normalised key is derived from the checked text.
export const TOPIC_TERM_FIELDS: Record<keyof TopicTerm, FieldDisposition> = {
  locale: exempt('internal-code'),
  kind: exempt('internal-code'),
  text: checked('topic.term'),
  key: exempt('internal-code'),
};

export const TOPIC_CONTENT_FIELDS: Record<keyof TopicContent, FieldDisposition> = {
  group: exempt('internal-code'),
  terms: nested('TOPIC_TERM_FIELDS'),
  intro: checked('topic.intro'),
};

export const TOPIC_FIELDS: Record<keyof TopicState, FieldDisposition> = {
  id: exempt('identifier'),
  // The slug is the address of the topic page, so it is a customer-visible text.
  slug: checked('topic.slug'),
  group: exempt('internal-code'),
  status: exempt('internal-code'),
  terms: nested('TOPIC_TERM_FIELDS'),
  intro: checked('topic.intro'),
  createdBy: exempt('identifier'),
  createdAt: exempt('timestamp'),
  updatedAt: exempt('timestamp'),
  version: exempt('number'),
};

/** Every table above by name, so the schema test can walk them and follow `nested`. */
export const FIELD_TABLES: Readonly<Record<string, Readonly<Record<string, FieldDisposition>>>> = {
  REVISION_TEXT_FIELDS,
  REVISION_VARIANT_FIELDS,
  REVISION_CONTENT_FIELDS,
  ATTRIBUTE_OPTION_FIELDS,
  ATTRIBUTE_DISPLAY_FIELDS,
  ATTRIBUTE_DEFINITION_FIELDS,
  FAMILY_ATTRIBUTE_FIELDS,
  FAMILY_GROUP_FIELDS,
  FEATURE_SET_FIELDS,
  CATEGORY_NAME_FIELDS,
  CATEGORY_TEXT_FIELDS,
  CATEGORY_SEO_FIELDS,
  PLATFORM_CATEGORY_FIELDS,
  OFFER_FIELDS,
  TOPIC_TERM_FIELDS,
  TOPIC_CONTENT_FIELDS,
  TOPIC_FIELDS,
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
  SellUnitState: {
    noCustomerText:
      'a variant id, a printable-ASCII SKU (1 to 64, no space) and a flag; no free text',
  },
  SellUnitChange: { noCustomerText: 'the same fields as SellUnitState, as requested' },
  SellUnitOutcome: { noCustomerText: 'lists of SellUnitState' },
  ImportColumn: { noCustomerText: 'fixed header names of the import template' },
  IgnoredColumn: { noCustomerText: 'a header of the file, shown to the admin only' },
  MappedColumns: { noCustomerText: 'column positions' },
  ParsedRow: { noCustomerText: 'raw cells of an import file; never shown to customers' },
  ParsedTable: { noCustomerText: 'raw cells of an import file; never shown to customers' },
  ImportFileParser: { noCustomerText: 'interface of methods' },
  ImportJob: { noCustomerText: 'admin job record: counts, states and a cleaned file label' },
  ImportRowRecord: { noCustomerText: 'admin report row: codes and the title as the admin sent it' },
  CheckEnvironment: { noCustomerText: 'facts of the Market a row is checked against' },
  RowIssue: { noCustomerText: 'issue code with a column and the cell as sent, for the admin only' },
  ImportPlan: {
    noCustomerText:
      'draft content for the platform save-draft use case, which claim-checks every text itself',
  },
  RowSummary: { noCustomerText: 'the admin report line of a row' },
  CheckedRow: { noCustomerText: 'the admin check result of a row' },
  SellerIgnoredColumn: { noCustomerText: 'a header of the file, shown to the seller only' },
  BracketColumn: { noCustomerText: 'column positions' },
  SellerColumnMap: { noCustomerText: 'column positions of a seller import file' },
  KnownBracketCodes: { noCustomerText: 'attribute codes of the Market family' },
  MergeBase: {
    noCustomerText:
      'the stored draft an import row is merged into; saved by the draft save, which checks every text',
  },
  MergeEnvironment: { noCustomerText: 'the default locale' },
  MergedRow: {
    noCustomerText:
      'draft content for the own-import row-save use case, which claim-checks every text itself',
  },
  ExistingOfferFact: {
    noCustomerText: 'ids and option keys of the seller own Offer, for the check',
  },
  CatalogueProductFact: { noCustomerText: 'ids and the type code of a catalogue product' },
  SellerCheckFacts: {
    noCustomerText: 'facts the seller import check reads about the seller own Offers',
  },
  SellerCheckEnvironment: {
    noCustomerText: 'facts of the Market a seller import row is checked against',
  },
  SellerRowIssue: {
    noCustomerText: 'issue code with a column and the cell as sent, for the seller only',
  },
  SellerRowSummary: { noCustomerText: 'the seller report line of a row' },
  SellerProductPatch: {
    noCustomerText:
      'draft content for the own-import row-save use case, which claim-checks every text itself',
  },
  SellerVariantPlan: {
    noCustomerText: 'option codes and V4 fields of a variant row, no free text',
  },
  SellerGroupPlan: {
    noCustomerText:
      'plan of one group for the own-import row use cases, which claim-check every text themselves',
  },
  CheckedSellerRow: { noCustomerText: 'the seller check result of a row' },
  CheckedSellerGroup: { noCustomerText: 'the seller check result of a group of rows' },
  SellerGroupRows: {
    noCustomerText: 'raw cells of a seller import file; never shown to customers',
  },
  SellerImportJob: { noCustomerText: 'seller job record: counts, states and a cleaned file label' },
  SellerRowRecord: {
    noCustomerText: 'seller report row: codes and the title as the seller sent it',
  },
  AttributeDefinition: { noCustomerText: 'aggregate class around AttributeDefinitionState' },
  AttributeFamily: { noCustomerText: 'aggregate class around AttributeFamilyState' },
  CategoryAttributeLink: { noCustomerText: 'aggregate class around CategoryAttributeLinkState' },
  AttributeRelaxationRequest: {
    noCustomerText: 'aggregate class around AttributeRelaxationRequestState',
  },
  AttributeValueSuggestion: {
    noCustomerText: 'aggregate class around AttributeValueSuggestionState',
  },
  AttributeValueSuggestionState: {
    noCustomerText:
      "a seller's value suggestion: ids, status codes, times and the seller's own text, shown to admins only; an approval writes the value's labels through the attribute editor, which claim-checks them",
  },
  SuggestionNoticeFacts: {
    noCustomerText: 'facts of the one mail to a seller about a suggestion; never shown to buyers',
  },
  SuggestionNoticeMail: {
    noCustomerText: 'the plain-text mail to a seller; never shown to buyers',
  },
  AttributeRelaxationRequestState: {
    noCustomerText: 'a two-admin request: ids, kind and status codes, times; no text',
  },
  LocalizedText: { noCustomerText: 'carrier type; every use sits inside a classified type' },
  OfferMovedPayloadRefused: { noCustomerText: 'refusal code with fixed paths' },
  PlatformCategory: { noCustomerText: 'aggregate class around PlatformCategoryState' },
  CategoryText: { table: 'CATEGORY_TEXT_FIELDS' },
  CategorySeo: { table: 'CATEGORY_SEO_FIELDS' },
  EditableCategory: {
    noCustomerText:
      'editor read model; its texts and search-result fields are CategoryText and CategorySeo',
  },
  FieldIssue: { noCustomerText: 'field path and a problem code' },
  RestructureChange: {
    noCustomerText: 'ids, a position, a status and a change kind of a move, merge or archive',
  },
  RestructurePlan: { noCustomerText: 'category ids and levels of a move, merge or archive plan' },
  TreeEdge: { noCustomerText: 'a category id and its parent id' },
  HiddenChange: { noCustomerText: 'ids and a state code' },
  PublishedOfferIdsInput: { noCustomerText: 'ids and a page size' },
  Product: { noCustomerText: 'aggregate class around ProductState' },
  Brand: { noCustomerText: 'aggregate class around BrandState' },
  // A brand's name and summary are read on its public page, but only an admin makes a brand public
  // (a seller's proposal is a draft until approved), and no certification claim is put in a
  // brand: the claim-text control covers product revisions, offers and category names only.
  BrandState: {
    noCustomerText: 'admin-approved brand text, outside the claim-text control (brand package)',
  },
  BrandContent: { noCustomerText: 'the editable text of a brand; see BrandState' },
  BrandFieldProblem: { noCustomerText: 'field path and a problem code' },
  ActivityFieldProblem: { noCustomerText: 'field path and a problem code' },
  ActivityLocales: { noCustomerText: 'locale codes' },
  BusinessActivityContent: {
    noCustomerText:
      'panel-only names and description of a business activity (admin and seller panels); refused when they assert a certification; see BusinessActivityState',
  },
  TopicContent: { table: 'TOPIC_CONTENT_FIELDS' },
  TopicFieldProblem: { noCustomerText: 'field path and a problem code' },
  TopicLocales: { noCustomerText: 'locale codes' },
  TopicState: { table: 'TOPIC_FIELDS' },
  TopicTerm: { table: 'TOPIC_TERM_FIELDS' },
  BusinessActivityState: {
    noCustomerText: 'a business activity as stored; panel-only text, see BusinessActivityContent',
  },
  RateVerdict: { noCustomerText: 'numbers' },
  SavedFilter: {
    noCustomerText:
      "an admin's own saved view; its name is shown to admins only and never to a customer",
  },
  VariantValidationResult: { noCustomerText: 'issue codes with fixed paths' },
  AttributeBounds: { noCustomerText: 'numbers' },
  AttributeMergeOption: { noCustomerText: 'two option codes of a merge; no text' },
  VariantTypeSettingsContent: {
    noCustomerText:
      'display codes, swatch colours and one seller-panel help sentence per locale; the help is shown to sellers only and the settings edit claim-checks it, fail closed',
  },
  VariantTypeSettingsState: {
    noCustomerText: 'the stored settings revision; see VariantTypeSettingsContent',
  },
  VariantTypeSettings: { noCustomerText: 'aggregate class around VariantTypeSettingsState' },
  OrderableOption: {
    noCustomerText: 'an option code, its position and the labels it is sorted by; no new text',
  },
  AttributeDefinitionState: { table: 'ATTRIBUTE_DEFINITION_FIELDS' },
  AttributeDisplaySettings: { table: 'ATTRIBUTE_DISPLAY_FIELDS' },
  AttributeFamilyState: { table: 'FEATURE_SET_FIELDS' },
  AttributeOption: { table: 'ATTRIBUTE_OPTION_FIELDS' },
  CatalogBatchTooLarge: { noCustomerText: 'refusal code' },
  CategoryAttributeLinkState: { noCustomerText: 'ids, attribute codes and counts; no text' },
  EffectiveAttributes: { noCustomerText: 'ids and attribute codes of a resolution; no text' },
  EffectiveFilter: { noCustomerText: 'an attribute code and a category id; no text' },
  LinkFact: { noCustomerText: 'a feature set id and attribute codes; no text' },
  CatalogFacade: { noCustomerText: 'interface of methods' },
  CatalogIndexFacade: { noCustomerText: 'interface of methods' },
  CatalogValidationFailed: { noCustomerText: 'refusal code with fixed paths' },
  CertificateExpiryNoticeMail: {
    noCustomerText: 'mail to an Offer owner from a type code, a count and a date; never content',
  },
  Classification: { noCustomerText: 'sensitive-change verdict: codes and flags' },
  MissingDetailsEmail: {
    noCustomerText: 'mail to a seller from fixed English text, product names and detail names',
  },
  MissingDetailsEmailInput: {
    noCustomerText: 'input of the seller mail: names already in the catalogue, never typed text',
  },
  MissingDetailsEmailProduct: {
    noCustomerText: 'a product name and detail names already in the catalogue',
  },
  CategoryName: { table: 'CATEGORY_NAME_FIELDS' },
  DraftText: { noCustomerText: 'a text found in a draft, already named by its checked field id' },
  FamilyAttribute: { table: 'FAMILY_ATTRIBUTE_FIELDS' },
  FamilyGroup: { table: 'FAMILY_GROUP_FIELDS' },
  FeatureSetContent: {
    noCustomerText: 'the names and groups of a feature set; see AttributeFamilyState',
  },
  FreezeInput: { noCustomerText: 'working input of the freeze; its texts are checked as content' },
  FreezeIssue: { noCustomerText: 'issue code with a fixed path' },
  OutcomeInput: { noCustomerText: 'ids and a decision code' },
  Offer: { noCustomerText: 'aggregate class around OfferState' },
  OfferState: { table: 'OFFER_FIELDS' },
  OfferPendingHistory: { noCustomerText: 'history kind, field ids and an instant' },
  OfferTagState: { noCustomerText: 'tag status, codes, ids, times and the TagBadge copy' },
  OfferTagPendingHistory: { noCustomerText: 'tag history: statuses, codes, ids and an instant' },
  TagSettlement: { noCustomerText: 'counts' },
  TagClaimQuery: { noCustomerText: 'claim query: ids, codes and a flag, built from stored state' },
  TagDecision: { noCustomerText: 'certification decision: codes, ids, instants and a TagBadge' },
  TagBadge: {
    noCustomerText:
      "display copy of certification's badge data (issuer display name included), written only by certification and never entered here (ADR-0028 d3)",
  },
  TagCopy: { noCustomerText: 'claim copy: basis, certificate ids and an instant' },
  TagActor: { noCustomerText: 'actor kind and account id' },
  ClaimFacts: { noCustomerText: 'ids of the revision, its variants and category paths' },
  OfferSearchFacts: {
    noCustomerText: 'read model feed: ids, a flag and OfferSearchText, nothing entered here',
  },
  OfferSearchVariant: {
    noCustomerText:
      'read copy of a published Variant: ids, a position, a GTIN, facet codes and its label (claim-checked when the revision was frozen); the label is index words only, never shown from the index',
  },
  OfferSearchAttributes: {
    noCustomerText:
      'index words and facet codes read from a published revision: brand name and aliases (an approved brand entity), a country name from the ISO list, option labels and searchable text values (admin text claim-checked when written; seller text claim-checked when the revision was frozen); matching only, never shown and never a certification claim',
  },
  SearchOption: {
    noCustomerText:
      'read copy of a published definition option label (admin text, claim-checked when written) and a merge target code',
  },
  SearchDefinition: {
    noCustomerText:
      'read copy of a published definition: type, flags and options (admin text, claim-checked when written)',
  },
  LoadedSearchDefinition: {
    noCustomerText:
      'read copy of a published definition with its names and options (admin text, claim-checked when written)',
  },
  SearchBrand: {
    noCustomerText: 'an approved brand entity: address, name and aliases (not product content)',
  },
  SearchAttributeFacts: {
    noCustomerText:
      'the same words and facet codes as OfferSearchAttributes, before they leave catalog',
  },
  SearchFilterOption: {
    noCustomerText:
      'an option code with its label: admin text claim-checked when written, a brand name or an ISO country name',
  },
  SearchFilterDefinition: {
    noCustomerText:
      'a filter of a listing: attribute code, name and options (admin text, claim-checked when written)',
  },
  SearchFiltersRequest: {
    noCustomerText: 'a category id, a locale tag, brand addresses and country codes',
  },
  SearchFilterUnavailable: { noCustomerText: 'one error code' },
  CatalogFiltersFacade: { noCustomerText: 'a facade interface: no text of its own' },
  OfferSearchText: {
    noCustomerText:
      'read copy of the published revision text, already claim-checked when the revision was frozen',
  },
  OfferSellUnits: { noCustomerText: 'sell units, numbers and ids' },
  OfferListing: {
    noCustomerText:
      'read copy of the published revision name and Variant label, already claim-checked when the revision was frozen, with ids and tags',
  },
  PublishedProduct: {
    noCustomerText:
      'read copy of the published revision texts and Variant labels, already claim-checked when the revision was frozen, with ids and the name of the active brand (an approved brand entity, not product content)',
  },
  PublishedSpecification: {
    noCustomerText:
      'read copy of a published revision attribute value (seller text already claim-checked when the revision was frozen) and the attribute name or option label (admin text, claim-checked when written)',
  },
  SpecificationOption: {
    noCustomerText:
      'read copy of a published definition option label (admin text, claim-checked when written) and a merge target code',
  },
  SpecificationDefinition: {
    noCustomerText:
      'read copy of a published definition: type, flags, names and options (admin text, claim-checked when written)',
  },
  SpecificationLocales: { noCustomerText: 'two locale tags' },
  PublishedSpecificationGroup: {
    noCustomerText: 'a family group code and its PublishedSpecification rows',
  },
  BrandProductIds: { noCustomerText: 'product ids and one flag; no text' },
  PublishedProductVariant: {
    noCustomerText: 'published Variant label read back from a revision, with ids and a position',
  },
  PublishedImageRef: { noCustomerText: 'a photo id and its pixel size; no text' },
  ProductLinkFacts: { noCustomerText: 'two flags (on sale, sold by the asked seller); no text' },
  OfferListingTag: { noCustomerText: 'tag status, basis code and the OfferListingBadge copy' },
  OfferBadge: {
    noCustomerText:
      "allow-listed copy of certification's live badge and its type name; never entered here (offerBadges)",
  },
  OfferListingBadge: {
    noCustomerText:
      "display copy of certification's badge data, written only by certification and never entered here (ADR-0028 d3)",
  },
  PlatformCategoryState: { table: 'PLATFORM_CATEGORY_FIELDS' },
  StoredCategoryNode: {
    noCustomerText:
      'read copy of stored category rows: ids, status, slug and the published CategoryName rows, already claim-checked when written',
  },
  LiveCategory: {
    noCustomerText:
      'public tree view: ids, slug and one published category name, already claim-checked when written, with numbers',
  },
  CategoryTreeUnavailableError: { noCustomerText: 'error with a fixed reason' },
  PublicCategoryDetails: {
    noCustomerText:
      'read copy of stored category fields: the menu switch, the English SEO fields and the published short descriptions, already claim-checked when written (C3a)',
  },
  PublicCategory: {
    noCustomerText:
      'public tree view: LiveCategory with the published short description and SEO fields, already claim-checked when written, with flags and numbers',
  },
  AdminStoredCategory: {
    noCustomerText:
      'admin read copy of stored category rows in any status: ids, slug and the published CategoryName rows, already claim-checked when written',
  },
  AdminCategoryRow: {
    noCustomerText:
      'admin tree row: ids, slug, status, the published CategoryName rows (already claim-checked when written) and numbers',
  },
  CategoryProductFact: { noCustomerText: 'category ids and counts of Offers; no text' },
  CategoryCounts: { noCustomerText: 'counts only' },
  CategoryImpactCounts: { noCustomerText: 'counts only' },
  AssistantCategory: {
    noCustomerText:
      'the public tree view for the buyer assistant: ids, slug, depth and one published category name, already claim-checked when written',
  },
  CatalogActivitiesFacade: { noCustomerText: 'interface of methods' },
  CatalogAssistantFacade: { noCustomerText: 'interface of methods' },
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
  SellUnitKey: { noCustomerText: 'ids' },
  SellUnitLabel: {
    noCustomerText: 'published product name and Variant label, read back from a revision',
  },
  SensitiveChangesPolicy: { noCustomerText: 'flags per change kind' },
  StoredRevision: { noCustomerText: 'record around the content; the texts are RevisionContent' },
  LabelDifference: {
    noCustomerText: 'admin report row: a stored label and the built one, never sent to a buyer',
  },
  VariantAxisValue: {
    noCustomerText: 'option label of the attribute definition, checked there (option-label)',
  },
  VariantDraft: { noCustomerText: 'ids and option codes; labels are RevisionVariantContent' },
  VariantIssue: { noCustomerText: 'issue code with a fixed path' },
  AxisIssue: { noCustomerText: 'issue code with a fixed path' },
  VariantRecord: { noCustomerText: 'ids and times' },
  VariantShipping: { noCustomerText: 'four whole numbers (grams, millimetres); no text' },
  WorkingCopy: { noCustomerText: 'opaque draft; its texts are checked before any write (6.1)' },
};
