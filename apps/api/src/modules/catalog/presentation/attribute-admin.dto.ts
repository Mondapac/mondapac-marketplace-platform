import { ApiProperty } from '@nestjs/swagger';
import { ATTRIBUTE_DATA_TYPES } from '@mondapac/shared-kernel';

// Answers of the admin attribute and feature-set reads (attributes plan, package A1). Codes, the
// names and labels an administrator or the seed typed per locale, counts; never a value a seller
// typed, never a permission.

const LOCALIZED = {
  type: 'object',
  additionalProperties: { type: 'string' },
  description: 'Locale (BCP 47) to text.',
} as const;

export class MarketLocalesBody {
  @ApiProperty({ description: 'The default locale (BCP 47).' }) default!: string;
  @ApiProperty({ type: [String], description: 'The default first, then every other locale.' })
  supported!: string[];
}

export class AttributeSummaryBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ description: 'Unique in the Market, never changes.' }) code!: string;
  @ApiProperty({ enum: ATTRIBUTE_DATA_TYPES }) dataType!: string;
  @ApiProperty() localizable!: boolean;
  @ApiProperty({ enum: ['draft', 'active', 'archived'] }) status!: string;
  @ApiProperty(LOCALIZED) names!: Record<string, string>;
  @ApiProperty() material!: boolean;
  @ApiProperty() isVariantOption!: boolean;
  @ApiProperty({ description: 'The number of the current revision.' }) revisionNo!: number;
  @ApiProperty({
    type: [String],
    description: 'Market locales without the name or the label of an active value.',
  })
  missingLocales!: string[];
}

export class AttributeListItemBody extends AttributeSummaryBody {
  @ApiProperty({ description: 'Published products whose current revision has a value for it.' })
  productCount!: number;
  @ApiProperty({ description: 'Feature sets that use it.' }) featureSetCount!: number;
}

export class FeatureSetRefBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
}

export class AttributeListBody {
  @ApiProperty({ type: [AttributeListItemBody] }) items!: AttributeListItemBody[];
  @ApiProperty({ nullable: true, type: String, description: 'The `afterId` of the next page.' })
  nextAfterId!: string | null;
  @ApiProperty({ description: 'Attributes that match the filters, across every page.' })
  total!: number;
  @ApiProperty({ description: 'Every attribute of the Market, whatever the filters.' })
  totalAll!: number;
  @ApiProperty({ type: MarketLocalesBody }) locales!: MarketLocalesBody;
  @ApiProperty({ type: [FeatureSetRefBody], description: 'The choices of the usedIn filter.' })
  featureSets!: FeatureSetRefBody[];
  @ApiProperty({ description: 'True when the Market holds more attributes than one read loads.' })
  truncated!: boolean;
}

export class AttributeOptionBody {
  @ApiProperty() code!: string;
  @ApiProperty(LOCALIZED) labels!: Record<string, string>;
  @ApiProperty() active!: boolean;
  @ApiProperty() position!: number;
  @ApiProperty({ description: 'Published products whose current revision holds this value.' })
  productCount!: number;
}

export class FeatureSetUseBody {
  @ApiProperty({ format: 'uuid' }) featureSetId!: string;
  @ApiProperty() featureSetCode!: string;
  @ApiProperty({ enum: ['active', 'archived'] }) featureSetStatus!: string;
  @ApiProperty() groupCode!: string;
  @ApiProperty() required!: boolean;
  @ApiProperty() isVariantOption!: boolean;
}

export class AttributeChangeBody {
  @ApiProperty({
    description:
      '`name.{locale}`, `material`, `isVariantOption`, `bounds.{maxLength|min|max}`, ' +
      '`help.{locale}`, `showOnProductPage`, `searchable`, `canBeFilter`, `position`, ' +
      '`internalNote` (no values: only that it changed), ' +
      '`option.{code}.added`, `option.{code}.label.{locale}`, `option.{code}.active` or ' +
      '`option.{code}.position`.',
  })
  field!: string;
  @ApiProperty({
    nullable: true,
    oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
  })
  before!: string | number | boolean | null;
  @ApiProperty({
    nullable: true,
    oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
  })
  after!: string | number | boolean | null;
}

export class AttributeHistoryBody {
  @ApiProperty() revisionNo!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ enum: ['seed', 'admin'] }) authorKind!: string;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) authorAccountId!: string | null;
  @ApiProperty({ type: [AttributeChangeBody], description: 'Empty for the first revision.' })
  changes!: AttributeChangeBody[];
}

export class AttributeBoundsBody {
  @ApiProperty({ required: false }) maxLength?: number;
  @ApiProperty({ required: false }) min?: number;
  @ApiProperty({ required: false }) max?: number;
}

export class AttributeDisplayBody {
  @ApiProperty({ ...LOCALIZED, description: 'Locale to the help text sellers see by the field.' })
  helpText!: Record<string, string>;
  @ApiProperty({ description: "Shown in the product page's specifications." })
  showOnProductPage!: boolean;
  @ApiProperty({ description: 'Its values are searched.' }) searchable!: boolean;
  @ApiProperty({ description: 'May be offered as a category filter.' }) canBeFilter!: boolean;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'For administrators only; never shown to sellers or buyers.',
  })
  internalNote!: string | null;
  @ApiProperty({ description: 'Order among attributes in admin lists and forms.' })
  position!: number;
}

export class AttributeDetailBody extends AttributeSummaryBody {
  @ApiProperty({ enum: ['seed', 'admin'] }) createdByKind!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ description: 'The version a later change names.' }) version!: number;
  @ApiProperty({ type: AttributeBoundsBody }) bounds!: AttributeBoundsBody;
  @ApiProperty({ type: AttributeDisplayBody }) display!: AttributeDisplayBody;
  @ApiProperty({ type: [AttributeOptionBody], description: 'By position.' })
  options!: AttributeOptionBody[];
  @ApiProperty() productCount!: number;
  @ApiProperty({ type: [FeatureSetUseBody] }) usedIn!: FeatureSetUseBody[];
  @ApiProperty({ type: [AttributeHistoryBody], description: 'Newest first, at most 100.' })
  history!: AttributeHistoryBody[];
  @ApiProperty() historyTruncated!: boolean;
  @ApiProperty({ type: MarketLocalesBody }) locales!: MarketLocalesBody;
}

export class FeatureSetListItemBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty({ enum: ['active', 'archived'] }) status!: string;
  @ApiProperty() revisionNo!: number;
  @ApiProperty({ ...LOCALIZED, description: 'Empty for the seeded feature set.' })
  names!: Record<string, string>;
  @ApiProperty() groupCount!: number;
  @ApiProperty() attributeCount!: number;
  @ApiProperty({ description: 'Published products whose current revision uses it.' })
  productCount!: number;
}

export class FeatureSetListBody {
  @ApiProperty({ type: [FeatureSetListItemBody] }) items!: FeatureSetListItemBody[];
  @ApiProperty({ description: 'True when the Market has more than 500 feature sets.' })
  truncated!: boolean;
}

export class FeatureSetAttributeBody {
  @ApiProperty() code!: string;
  @ApiProperty() required!: boolean;
  @ApiProperty({ enum: ['required', 'recommended', 'optional'] }) level!: string;
  @ApiProperty() isVariantOption!: boolean;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) attributeId!: string | null;
  @ApiProperty({ ...LOCALIZED, nullable: true }) names!: Record<string, string> | null;
  @ApiProperty({ nullable: true, enum: ATTRIBUTE_DATA_TYPES }) dataType!: string | null;
  @ApiProperty({ nullable: true, type: String }) status!: string | null;
  @ApiProperty({ nullable: true, type: Boolean }) material!: boolean | null;
}

export class FeatureSetGroupBody {
  @ApiProperty() groupCode!: string;
  @ApiProperty({ ...LOCALIZED, description: 'Empty before package A4.' })
  names!: Record<string, string>;
  @ApiProperty({ type: [FeatureSetAttributeBody] }) attributes!: FeatureSetAttributeBody[];
}

export class FeatureSetDetailBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty({ enum: ['active', 'archived'] }) status!: string;
  @ApiProperty() revisionNo!: number;
  @ApiProperty({ description: 'The version the editor names when it saves.' }) version!: number;
  @ApiProperty({ ...LOCALIZED, description: 'Empty for the seeded feature set.' })
  names!: Record<string, string>;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: [FeatureSetGroupBody] }) groups!: FeatureSetGroupBody[];
  @ApiProperty() productCount!: number;
  @ApiProperty({ type: MarketLocalesBody }) locales!: MarketLocalesBody;
}

// Requests and answers of the attribute editor (attributes plan, package A2).

export class AttributeOptionRequest {
  @ApiProperty({
    required: false,
    description:
      'Lower-case code; left out, it comes from the default-locale label. Never changes.',
  })
  code?: string;
  @ApiProperty(LOCALIZED) labels!: Record<string, string>;
  @ApiProperty({ required: false, default: true }) active?: boolean;
}

export class AttributeContentRequest {
  @ApiProperty({ ...LOCALIZED, description: 'Locale to name; the default locale is required.' })
  names!: Record<string, string>;
  @ApiProperty({ required: false }) material?: boolean;
  @ApiProperty({ required: false }) isVariantOption?: boolean;
  @ApiProperty({ type: AttributeBoundsBody, required: false }) bounds?: AttributeBoundsBody;
  @ApiProperty({
    type: [AttributeOptionRequest],
    required: false,
    description: 'Every value, in order. On edit no existing value may be left out.',
  })
  options?: AttributeOptionRequest[];
  @ApiProperty({ ...LOCALIZED, description: 'Locale to help text; optional.' })
  helpText?: Record<string, string>;
  @ApiProperty({ required: false, default: true }) showOnProductPage?: boolean;
  @ApiProperty({ required: false }) searchable?: boolean;
  @ApiProperty({ required: false }) canBeFilter?: boolean;
  @ApiProperty({ required: false, nullable: true, type: String }) internalNote?: string | null;
  @ApiProperty({ required: false }) position?: number;
}

export class AttributeCreateRequest extends AttributeContentRequest {
  @ApiProperty({ enum: ATTRIBUTE_DATA_TYPES }) dataType!: string;
  @ApiProperty({ required: false, description: 'Left out, it comes from the default name.' })
  code?: string;
  @ApiProperty({ required: false }) localizable?: boolean;
}

export class AttributeEditRequest extends AttributeContentRequest {
  @ApiProperty({ description: 'The version the admin saw.' }) version!: number;
}

export class AttributeVersionRequest {
  @ApiProperty({ description: 'The version the admin saw.' }) version!: number;
}

export class AttributeWriteBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty({ enum: ['draft', 'active', 'archived'] }) status!: string;
  @ApiProperty() version!: number;
  @ApiProperty() revisionNo!: number;
}

export class AttributeWriteWrapBody {
  @ApiProperty({ type: AttributeWriteBody }) attribute!: AttributeWriteBody;
}

// The two-person request to clear `material` (catalog design 8.2; attributes A2 part 3).

export class RelaxationRequestCreateRequest {
  @ApiProperty({ description: 'The attribute version the admin saw.' }) version!: number;
  @ApiProperty({
    enum: ['clear-material'],
    description: 'What to relax. Only clear-material today.',
  })
  kind!: string;
}

export class RelaxationVersionRequest {
  @ApiProperty({ description: 'The request version the admin saw.' }) version!: number;
}

export class RelaxationWriteBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) attributeId!: string;
  @ApiProperty({ enum: ['clear-material', 'archive', 'remove-from-family'] }) kind!: string;
  @ApiProperty({ enum: ['open', 'confirmed', 'cancelled', 'expired'] }) status!: string;
  @ApiProperty() version!: number;
  @ApiProperty({ format: 'date-time' }) requestedAt!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
}

export class RelaxationWriteWrapBody {
  @ApiProperty({ type: RelaxationWriteBody }) request!: RelaxationWriteBody;
}

export class RelaxationConfirmBody {
  @ApiProperty({ type: RelaxationWriteBody }) request!: RelaxationWriteBody;
  @ApiProperty({ type: AttributeWriteBody }) attribute!: AttributeWriteBody;
}

class RelaxationActionBody {
  @ApiProperty() allowed!: boolean;
  @ApiProperty({
    required: false,
    enum: ['relaxation.same-admin', 'relaxation.not-requester'],
    description: 'Why not, when not allowed.',
  })
  reason?: string;
}

class RelaxationActionsBody {
  @ApiProperty({ type: RelaxationActionBody }) confirm!: RelaxationActionBody;
  @ApiProperty({ type: RelaxationActionBody }) cancel!: RelaxationActionBody;
}

class RelaxationAttributeBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty(LOCALIZED) names!: Record<string, string>;
  @ApiProperty() version!: number;
}

export class OpenRelaxationBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() version!: number;
  @ApiProperty({ enum: ['clear-material', 'archive', 'remove-from-family'] }) kind!: string;
  @ApiProperty({ type: RelaxationAttributeBody }) attribute!: RelaxationAttributeBody;
  @ApiProperty({ description: "The reader's own request: cancel, not confirm." }) mine!: boolean;
  @ApiProperty({ format: 'uuid', description: 'The requesting administrator.' })
  requestedByAccountId!: string;
  @ApiProperty({ format: 'date-time' }) requestedAt!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty({ type: RelaxationActionsBody }) allowedActions!: RelaxationActionsBody;
}

export class OpenRelaxationListBody {
  @ApiProperty({ type: [OpenRelaxationBody] }) requests!: OpenRelaxationBody[];
}

// Requests and answers of the feature-set editor (attributes plan, package A4).

export class FeatureSetEntryRequest {
  @ApiProperty({ description: 'The code of an active attribute.' }) code!: string;
  @ApiProperty({ enum: ['required', 'recommended', 'optional'] }) level!: string;
}

export class FeatureSetGroupRequest {
  @ApiProperty({
    required: false,
    description:
      'Lower-case code; left out, it comes from the default-locale name. The Core group is `core`.',
  })
  groupCode?: string;
  @ApiProperty({ ...LOCALIZED, description: 'Locale to name; the default locale is required.' })
  names!: Record<string, string>;
  @ApiProperty({ type: [FeatureSetEntryRequest], description: 'In order.' })
  attributes!: FeatureSetEntryRequest[];
}

export class FeatureSetContentRequest {
  @ApiProperty({ ...LOCALIZED, description: 'Locale to name; the default locale is required.' })
  names!: Record<string, string>;
  @ApiProperty({
    type: [FeatureSetGroupRequest],
    description: 'In order. The first is the Core group (brand and country of origin).',
  })
  groups!: FeatureSetGroupRequest[];
}

export class FeatureSetCreateRequest extends FeatureSetContentRequest {
  @ApiProperty({ required: false, description: 'Left out, it comes from the default-locale name.' })
  code?: string;
}

export class FeatureSetEditRequest extends FeatureSetContentRequest {
  @ApiProperty({ description: 'The version the admin saw.' }) version!: number;
}

export class FeatureSetWriteBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty({ enum: ['active', 'archived'] }) status!: string;
  @ApiProperty() version!: number;
  @ApiProperty() revisionNo!: number;
}

export class FeatureSetWriteWrapBody {
  @ApiProperty({ type: FeatureSetWriteBody }) featureSet!: FeatureSetWriteBody;
}
