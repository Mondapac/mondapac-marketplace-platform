import { ApiProperty } from '@nestjs/swagger';
import { ATTRIBUTE_DATA_TYPES, MEASURE_DIMENSIONS } from '@mondapac/shared-kernel';

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

export class MarketUnitBody {
  @ApiProperty() code!: string;
  @ApiProperty({ enum: MEASURE_DIMENSIONS }) dimension!: string;
  @ApiProperty(LOCALIZED) labels!: Record<string, string>;
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
  @ApiProperty({ type: [MarketUnitBody], description: 'Units a measure attribute may offer.' })
  units!: MarketUnitBody[];
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
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The value this one was merged into (attributes A8), or null.',
  })
  mergedInto!: string | null;
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
      '`measure.{dimension|units|defaultUnit|decimals}`, ' +
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

export class AttributeMeasureBody {
  @ApiProperty({ enum: MEASURE_DIMENSIONS }) dimension!: string;
  @ApiProperty({
    type: [String],
    description: 'Unit codes a seller may pick; all of the dimension.',
  })
  units!: string[];
  @ApiProperty() defaultUnit!: string;
  @ApiProperty({ description: 'Decimal places a seller may type, 0 to 6.' }) decimals!: number;
}

export class AttributeBoundsBody {
  @ApiProperty({ required: false }) maxLength?: number;
  @ApiProperty({
    required: false,
    description: 'For a measure, in the dimension base unit (g, ml, mm, count).',
  })
  min?: number;
  @ApiProperty({ required: false }) max?: number;
  @ApiProperty({
    required: false,
    type: AttributeMeasureBody,
    description: 'A measure attribute only: its unit settings.',
  })
  measure?: AttributeMeasureBody;
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
  @ApiProperty({ type: [MarketUnitBody], description: 'Units a measure attribute may offer.' })
  units!: MarketUnitBody[];
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

export class CategoryLinksSetRequest {
  @ApiProperty({
    format: 'uuid',
    nullable: true,
    description: 'The feature set the category holds; null means it takes its parent’s.',
  })
  featureSetId!: string | null;
  @ApiProperty({
    type: [String],
    description: 'Filterable attribute codes in the order buyers see.',
  })
  filters!: string[];
  @ApiProperty({
    required: false,
    description: 'The version the admin saw; omitted when the category has no link yet.',
  })
  version?: number;
}

export class CategoryLinksOwnBody {
  @ApiProperty({ format: 'uuid', nullable: true }) featureSetId!: string | null;
  @ApiProperty({ type: [String] }) filters!: string[];
  @ApiProperty() revisionNo!: number;
  @ApiProperty({ description: 'The version the editor names when it saves.' }) version!: number;
}

export class CategoryLinksFeatureSetBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty(LOCALIZED) names!: Record<string, string>;
  @ApiProperty({ format: 'uuid', description: 'The category that holds it.' })
  fromCategoryId!: string;
  @ApiProperty({ description: 'True when an ancestor holds it.' }) inherited!: boolean;
}

export class CategoryLinksFilterBody {
  @ApiProperty() code!: string;
  @ApiProperty({ format: 'uuid' }) fromCategoryId!: string;
  @ApiProperty() inherited!: boolean;
  @ApiProperty({ ...LOCALIZED, nullable: true }) names!: Record<string, string> | null;
  @ApiProperty({ enum: ATTRIBUTE_DATA_TYPES, nullable: true }) dataType!: string | null;
  @ApiProperty({ nullable: true }) status!: string | null;
}

export class CategoryLinksEffectiveBody {
  @ApiProperty({ type: CategoryLinksFeatureSetBody, nullable: true })
  featureSet!: CategoryLinksFeatureSetBody | null;
  @ApiProperty({ type: [CategoryLinksFilterBody] }) filters!: CategoryLinksFilterBody[];
}

export class CategoryLinksBody {
  @ApiProperty({ format: 'uuid' }) categoryId!: string;
  @ApiProperty({ type: CategoryLinksOwnBody, nullable: true }) own!: CategoryLinksOwnBody | null;
  @ApiProperty({ type: CategoryLinksEffectiveBody }) effective!: CategoryLinksEffectiveBody;
}

export class CategoryLinksSetBody {
  @ApiProperty({ format: 'uuid' }) categoryId!: string;
  @ApiProperty({ format: 'uuid', nullable: true }) featureSetId!: string | null;
  @ApiProperty({ type: [String] }) filters!: string[];
  @ApiProperty() revisionNo!: number;
  @ApiProperty() version!: number;
}

export class CategoryLinksSetWrapBody {
  @ApiProperty({ type: CategoryLinksSetBody }) links!: CategoryLinksSetBody;
}

export class MissingDetailsItemBody {
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty() productCode!: string;
  @ApiProperty({ nullable: true, type: String, description: 'The name in the default locale.' })
  name!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'uuid',
    description: 'Null for a PLATFORM product.',
  })
  sellerId!: string | null;
  @ApiProperty() featureSetCode!: string;
  @ApiProperty({ type: [String], description: 'Codes of the required attributes with no value.' })
  missing!: string[];
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'date-time',
    description:
      'When an "Email sellers" mail about it last went to its seller; null when never, or while a newer request waits.',
  })
  lastEmailedAt!: string | null;
}

export class MissingDetailsListBody {
  @ApiProperty({ type: [MissingDetailsItemBody] }) items!: MissingDetailsItemBody[];
  @ApiProperty({ nullable: true, type: String, description: 'The `afterId` of the next call.' })
  nextAfterId!: string | null;
  @ApiProperty({ description: 'Published products this call read.' }) scanned!: number;
  @ApiProperty({
    type: [String],
    description: 'Feature sets that could not be read; their products are not judged.',
  })
  unreadableFeatureSets!: string[];
}

export class MissingDetailsEmailRequest {
  @ApiProperty({
    type: [String],
    description: 'The products to ask about, 1 to 200 ids. Judged again on the server.',
  })
  productIds!: string[];
  @ApiProperty({
    required: false,
    description: 'True: only report who would be emailed; nothing is written.',
  })
  dryRun?: boolean;
}

class MissingDetailsEmailProductBody {
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty() productCode!: string;
  @ApiProperty({ nullable: true, type: String }) name!: string | null;
  @ApiProperty({ type: [String], description: 'English names of the missing details.' })
  missing!: string[];
  @ApiProperty({ enum: ['will-send', 'queued', 'recently-emailed'] }) status!: string;
  @ApiProperty({ nullable: true, type: String, description: 'When the seller was last asked.' })
  lastRequestedAt!: string | null;
}

class MissingDetailsEmailSellerBody {
  @ApiProperty({ format: 'uuid' }) sellerId!: string;
  @ApiProperty({ nullable: true, type: String }) sellerName!: string | null;
  @ApiProperty({ type: [MissingDetailsEmailProductBody] })
  products!: MissingDetailsEmailProductBody[];
}

class MissingDetailsEmailIgnoredBody {
  @ApiProperty({ format: 'uuid' }) productId!: string;
  @ApiProperty({ enum: ['not-published', 'platform-product', 'nothing-missing'] }) reason!: string;
}

export class MissingDetailsEmailBody {
  @ApiProperty() dryRun!: boolean;
  @ApiProperty({ description: 'A seller is asked about a product at most once in this many days.' })
  throttleDays!: number;
  @ApiProperty({ type: [MissingDetailsEmailSellerBody] })
  sellers!: MissingDetailsEmailSellerBody[];
  @ApiProperty({ type: [MissingDetailsEmailIgnoredBody] })
  ignored!: MissingDetailsEmailIgnoredBody[];
}

// The restructure routes (attributes A8): the impact dialog, merging values and archiving.

class ImpactCountBody {
  @ApiProperty() count!: number;
  @ApiProperty({ description: 'True when the real number is count or more (the read stopped).' })
  atLeast!: boolean;
}

class ImpactFeatureSetBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  names!: Record<string, string>;
}

class ImpactAttributeBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty({ enum: ['draft', 'active', 'archived'] }) status!: string;
  @ApiProperty() version!: number;
  @ApiProperty() material!: boolean;
  @ApiProperty() isVariantOption!: boolean;
  @ApiProperty() dataType!: string;
}

class ImpactBody {
  @ApiProperty({ type: ImpactCountBody }) publishedProducts!: ImpactCountBody;
  @ApiProperty({ type: ImpactCountBody }) drafts!: ImpactCountBody;
  @ApiProperty() featureSetCount!: number;
  @ApiProperty({ type: [ImpactFeatureSetBody] }) featureSets!: ImpactFeatureSetBody[];
  @ApiProperty({ type: ImpactCountBody }) categories!: ImpactCountBody;
  @ApiProperty({ type: ImpactCountBody }) filters!: ImpactCountBody;
  @ApiProperty({ type: ImpactCountBody }) liveVariantProducts!: ImpactCountBody;
}

export class AttributeImpactBody {
  @ApiProperty({ type: ImpactAttributeBody }) attribute!: ImpactAttributeBody;
  @ApiProperty({ type: ImpactBody }) impact!: ImpactBody;
}

export class AttributeMergeRequest {
  @ApiProperty({ description: 'The version of the attribute that is merged away.' })
  version!: number;
  @ApiProperty({ description: 'The id of the active attribute of the same type it goes into.' })
  target!: string;
  @ApiProperty({ description: 'The version of the target the impact dialog showed.' })
  targetVersion!: number;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'For a choice attribute: every value code of the source to a target value code.',
  })
  options?: Record<string, string>;
}

export class AttributeConvertRequest {
  @ApiProperty({ description: 'The attribute version the impact dialog showed.' })
  version!: number;
  @ApiProperty({
    enum: ['decimal', 'multi-select'],
    description: 'The new type: decimal (from integer) or multi-select (from select).',
  })
  to!: string;
}

export class ValuesMergeRequest {
  @ApiProperty({ description: 'The attribute version the impact dialog showed.' })
  version!: number;
  @ApiProperty({ description: 'The code of the value that is merged away.' }) source!: string;
  @ApiProperty({ description: 'The code of the active value it is merged into.' }) target!: string;
}
