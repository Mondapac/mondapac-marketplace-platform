import { ApiProperty } from '@nestjs/swagger';

// Answers of the seller read routes (catalog design 8.2, 9.2a). Ids, codes and the seller's own
// content only; instants are ISO 8601 strings in UTC.

export class OwnProductListItemView {
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty({ example: 'P00000001' }) productCode!: string;
  @ApiProperty() typeCode!: string;
  @ApiProperty({
    description:
      'draft, unpublished, published, matched or retired (the discarded and withdrawn are not listed).',
  })
  status!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The draft name in the default locale.',
  })
  draftName!: string | null;
  @ApiProperty() hasPublishedRevision!: boolean;
  @ApiProperty() hasPendingRevision!: boolean;
  @ApiProperty({ nullable: true, type: String }) pendingSubmittedAt!: string | null;
  @ApiProperty() lastChangedAt!: string;
  @ApiProperty() createdAt!: string;
}

export class OwnProductList {
  @ApiProperty({ type: [OwnProductListItemView] }) items!: OwnProductListItemView[];
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Send as `afterId` for the next page; null on the last page.',
  })
  nextAfterId!: string | null;
}

export class OwnRevisionViewDto {
  @ApiProperty({ format: 'uuid' }) revisionId!: string;
  @ApiProperty() revisionNo!: number;
  @ApiProperty() submittedAt!: string;
  @ApiProperty({ enum: ['seller', 'admin'] }) authorKind!: string;
  @ApiProperty() sensitive!: boolean;
  @ApiProperty({ type: [String] }) sensitiveReasons!: string[];
  @ApiProperty({ type: 'object', additionalProperties: true, description: 'The frozen content.' })
  content!: Record<string, unknown>;
}

export class OwnWorkingCopyView {
  @ApiProperty({ type: 'object', additionalProperties: true }) content!: Record<string, unknown>;
  @ApiProperty() lastSavedAt!: string;
  @ApiProperty({ nullable: true, type: String }) baseRevisionId!: string | null;
}

export class OwnVariantView {
  @ApiProperty({ format: 'uuid' }) variantId!: string;
  @ApiProperty({ description: 'proposed, published or retired.' }) state!: string;
}

const LOCALE_MAP = { type: 'object', additionalProperties: { type: 'string' } } as const;

export class OwnFormOption {
  @ApiProperty() code!: string;
  @ApiProperty(LOCALE_MAP) labels!: Record<string, string>;
}

export class OwnFormBounds {
  @ApiProperty({ required: false }) maxLength?: number;
  @ApiProperty({ required: false }) min?: number;
  @ApiProperty({ required: false }) max?: number;
}

export class OwnFormMeasure {
  @ApiProperty({ enum: ['mass', 'volume', 'length', 'count'] }) dimension!: string;
  @ApiProperty({ type: [String], description: 'Unit codes the seller may pick.' }) units!: string[];
  @ApiProperty() defaultUnit!: string;
  @ApiProperty({ description: 'Decimal places the seller may type in the unit picked.' })
  decimals!: number;
}

export class OwnFormUnit {
  @ApiProperty() code!: string;
  @ApiProperty(LOCALE_MAP) labels!: Record<string, string>;
}

export class OwnFormField {
  @ApiProperty() code!: string;
  @ApiProperty({
    description:
      'text, long-text, integer, decimal, boolean, select, multi-select, date or measure.',
  })
  dataType!: string;
  @ApiProperty() localizable!: boolean;
  @ApiProperty() required!: boolean;
  @ApiProperty() isVariantOption!: boolean;
  @ApiProperty({ type: OwnFormBounds }) bounds!: OwnFormBounds;
  @ApiProperty({
    type: OwnFormMeasure,
    required: false,
    description:
      'A measure field only. Min and max in bounds are in base units (g, ml, mm, count).',
  })
  measure?: OwnFormMeasure;
  @ApiProperty(LOCALE_MAP) names!: Record<string, string>;
  @ApiProperty({ type: [OwnFormOption] }) options!: OwnFormOption[];
}

export class OwnFormCategory {
  @ApiProperty({ format: 'uuid' }) categoryId!: string;
  @ApiProperty({ format: 'uuid', nullable: true, type: String }) parentId!: string | null;
  @ApiProperty(LOCALE_MAP) names!: Record<string, string>;
}

export class OwnProductForm {
  @ApiProperty({ type: [String] }) taxCategoryCodes!: string[];
  @ApiProperty({
    type: [OwnFormUnit],
    description:
      "The Market's units with a label per locale (a measure field names units by code).",
  })
  units!: OwnFormUnit[];
  @ApiProperty({ type: [OwnFormField], description: 'The fields of the product family.' })
  fields!: OwnFormField[];
  @ApiProperty({ type: [OwnFormCategory], description: 'Active platform categories.' })
  categories!: OwnFormCategory[];
}

export class OwnChangeRequestView {
  @ApiProperty({ format: 'uuid' }) revisionId!: string;
  @ApiProperty() revisionNo!: number;
  @ApiProperty({ description: 'A reason code of the Market list; the panel words it.' })
  reasonCode!: string;
  @ApiProperty({ description: 'ISO instant.' }) decidedAt!: string;
}

export class OwnSuggestionView {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ description: 'The code of the field the value was suggested for.' })
  attributeCode!: string;
  @ApiProperty({ description: "The seller's own text. Show as plain text." }) label!: string;
  @ApiProperty({ enum: ['open', 'approved', 'mapped', 'rejected'] }) status!: string;
  @ApiProperty({ nullable: true, type: String, description: 'The value added or chosen.' })
  optionCode!: string | null;
  @ApiProperty({ nullable: true, type: String, description: "The reviewer's words (rejected)." })
  rejectReason!: string | null;
  @ApiProperty({ description: 'ISO instant.' }) createdAt!: string;
}

export class OwnProductView {
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty() productCode!: string;
  @ApiProperty() typeCode!: string;
  @ApiProperty() familyCode!: string;
  @ApiProperty({ description: 'single (one fixed variant) or configurable.' })
  variantModel!: string;
  @ApiProperty() status!: string;
  @ApiProperty({
    description:
      'The seller marked the product as carrying their own brand (it lets them propose a brand).',
  })
  ownBrand!: boolean;
  @ApiProperty({ type: [OwnVariantView] }) variants!: OwnVariantView[];
  @ApiProperty({ description: "The Market's cap on non-retired variants." }) maxVariants!: number;
  @ApiProperty({ description: "The Market's cap on the options a product varies on (1 or 2)." })
  maxAxes!: number;
  @ApiProperty({ description: 'The product version, to send back with Add sizes.' })
  version!: number;
  @ApiProperty({
    type: [String],
    description: 'Changes the Market sends to review, plus `images` (always).',
  })
  sensitiveFields!: string[];
  @ApiProperty() lastChangedAt!: string;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ nullable: true, type: String }) pendingSubmittedAt!: string | null;
  @ApiProperty({ type: OwnProductForm }) form!: OwnProductForm;
  @ApiProperty({ nullable: true, type: OwnWorkingCopyView })
  workingCopy!: OwnWorkingCopyView | null;
  @ApiProperty({ nullable: true, type: OwnRevisionViewDto }) published!: OwnRevisionViewDto | null;
  @ApiProperty({ nullable: true, type: OwnRevisionViewDto }) pending!: OwnRevisionViewDto | null;
  @ApiProperty({
    nullable: true,
    type: OwnChangeRequestView,
    description:
      'The reviewer sent the newest revision back; null when it was not (a newer submit clears it).',
  })
  changeRequest!: OwnChangeRequestView | null;
  @ApiProperty({
    type: [OwnSuggestionView],
    description:
      'Value suggestions for this product, newest first. An open one keeps its field empty ' +
      '(a required field then holds back the submit: attribute.suggestion-pending).',
  })
  suggestions!: OwnSuggestionView[];
}

export class OwnOfferProductLabel {
  @ApiProperty({ nullable: true, type: String }) productCode!: string | null;
  @ApiProperty({ nullable: true, type: String }) typeCode!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Published name, default locale.' })
  name!: string | null;
}

export class OwnOfferTagBadgeIssuer {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() displayName!: string;
}

export class OwnOfferTagBadge {
  @ApiProperty() typeCode!: string;
  @ApiProperty({ format: 'uuid', description: 'Texts and icon of the badge come from it.' })
  typeRevisionId!: string;
  @ApiProperty({ enum: ['SELLER', 'MANUFACTURER'] }) basis!: string;
  @ApiProperty() sellerClaim!: boolean;
  @ApiProperty({ type: OwnOfferTagBadgeIssuer, nullable: true })
  issuer!: OwnOfferTagBadgeIssuer | null;
  @ApiProperty({ nullable: true, type: String, description: 'YYYY-MM-DD in validUntilZone.' })
  validUntilLocalDate!: string | null;
  @ApiProperty({ nullable: true, type: String }) validUntilZone!: string | null;
  @ApiProperty() verifiedWithIssuer!: boolean;
  @ApiProperty({ enum: [true] }) reviewedByPlatform!: boolean;
}

export class OwnOfferTagView {
  @ApiProperty() typeCode!: string;
  @ApiProperty({
    enum: ['pending-publish', 'active', 'rechecking', 'suspended'],
    description:
      'pending-publish: checked at submit, confirmed at publish (no badge); suspended: the ' +
      'Offer is off sale for it, see reasonCode.',
  })
  status!: string;
  @ApiProperty({
    nullable: true,
    enum: ['SELLER', 'MANUFACTURER'],
    description: 'The basis of the last allowed decision (CERT-24).',
  })
  basis!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The last ClaimReason code (CUX 3.7 words come from it).',
  })
  reasonCode!: string | null;
  @ApiProperty({
    type: OwnOfferTagBadge,
    nullable: true,
    description: 'The display copy of the badge, only while active; never an authorisation.',
  })
  badge!: OwnOfferTagBadge | null;
}

export class OwnOfferViewDto {
  @ApiProperty({ format: 'uuid' }) offerId!: string;
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty({ type: OwnOfferProductLabel }) product!: OwnOfferProductLabel;
  @ApiProperty() sellerSku!: string;
  @ApiProperty() conditionCode!: string;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  description!: Record<string, string>;
  @ApiProperty({
    description: 'draft, pending-first-publish, changes-needed or published.',
  })
  status!: string;
  @ApiProperty() listed!: boolean;
  @ApiProperty({ type: [String] }) offSaleCauses!: string[];
  @ApiProperty({ nullable: true, type: String }) handling!: string | null;
  @ApiProperty() attestationRecorded!: boolean;
  @ApiProperty({ nullable: true, type: String }) submittedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) firstPublishedAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() version!: number;
  @ApiProperty({
    type: [OwnOfferTagView],
    required: false,
    description: 'The open tags of the Offer; on the single-Offer read only.',
  })
  tags?: OwnOfferTagView[];
}

export class OwnOfferStatusCounts {
  @ApiProperty() draft!: number;
  @ApiProperty() pendingFirstPublish!: number;
  @ApiProperty() changesNeeded!: number;
  @ApiProperty() published!: number;
}

export class OwnOfferList {
  @ApiProperty({ type: [OwnOfferViewDto] }) items!: OwnOfferViewDto[];
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Send as `afterId` for the next page; null on the last page.',
  })
  nextAfterId!: string | null;
  @ApiProperty({
    type: OwnOfferStatusCounts,
    description: "All the seller's Offers per status (deleted left out), whatever the page.",
  })
  counts!: OwnOfferStatusCounts;
}

export class OwnProductOptionsLocales {
  @ApiProperty() default!: string;
  @ApiProperty({ type: [String] }) supported!: string[];
}

export class OwnProductOptions {
  @ApiProperty({
    type: [String],
    description:
      'The product types the Market offers. Not yet narrowed to what the seller may sell: a create with a type the seller may not sell answers 422 type.not-allowed.',
  })
  productTypes!: string[];
  @ApiProperty({ type: [String], description: 'The condition codes an Offer may carry.' })
  conditions!: string[];
  @ApiProperty({ type: OwnProductOptionsLocales })
  locales!: OwnProductOptionsLocales;
  @ApiProperty({
    description:
      'False when the Market does not let sellers create products (the form should not open).',
  })
  sellerCanCreateProduct!: boolean;
  @ApiProperty({ type: [String], description: 'Statuses a seller sees on products in lists.' })
  productStatuses!: string[];
  @ApiProperty({ type: [String], description: 'Statuses a seller sees on Offers in lists.' })
  offerStatuses!: string[];
}
