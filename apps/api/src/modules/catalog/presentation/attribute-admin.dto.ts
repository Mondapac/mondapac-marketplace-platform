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

export class AttributeDetailBody extends AttributeSummaryBody {
  @ApiProperty({ enum: ['seed', 'admin'] }) createdByKind!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ description: 'The version a later change names.' }) version!: number;
  @ApiProperty({ type: AttributeBoundsBody }) bounds!: AttributeBoundsBody;
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
  @ApiProperty() isVariantOption!: boolean;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) attributeId!: string | null;
  @ApiProperty({ ...LOCALIZED, nullable: true }) names!: Record<string, string> | null;
  @ApiProperty({ nullable: true, enum: ATTRIBUTE_DATA_TYPES }) dataType!: string | null;
  @ApiProperty({ nullable: true, type: String }) status!: string | null;
  @ApiProperty({ nullable: true, type: Boolean }) material!: boolean | null;
}

export class FeatureSetGroupBody {
  @ApiProperty() groupCode!: string;
  @ApiProperty({ type: [FeatureSetAttributeBody] }) attributes!: FeatureSetAttributeBody[];
}

export class FeatureSetDetailBody {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty({ enum: ['active', 'archived'] }) status!: string;
  @ApiProperty() revisionNo!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: [FeatureSetGroupBody] }) groups!: FeatureSetGroupBody[];
  @ApiProperty() productCount!: number;
  @ApiProperty({ type: MarketLocalesBody }) locales!: MarketLocalesBody;
}
