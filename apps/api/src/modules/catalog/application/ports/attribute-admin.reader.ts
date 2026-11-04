import type { AttributeDataType, Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type {
  AttributeBounds,
  AttributeDisplaySettings,
  AttributeOption,
  LocalizedText,
} from '../../domain/attribute-definition';
import type { FamilyGroup } from '../../domain/attribute-family';
import type { CategoryAuthorKind } from '../../domain/platform-category';

/** A definition with its current (published) revision and that revision's options. */
export interface AttributeDefinitionRecord {
  readonly id: Id<'AttributeDefinition'>;
  readonly code: string;
  readonly dataType: AttributeDataType;
  readonly localizable: boolean;
  readonly status: string;
  readonly createdByKind: CategoryAuthorKind;
  readonly createdAt: Temporal.Instant;
  /** The definition's version, which a later edit names (package A2). */
  readonly version: number;
  readonly revision: AttributeRevisionRecord;
}

/** One insert-only revision of a definition, with its options. */
export interface AttributeRevisionRecord {
  readonly id: Id<'AttributeDefinitionRevision'>;
  readonly revisionNo: number;
  readonly material: boolean;
  readonly isVariantOption: boolean;
  readonly bounds: AttributeBounds;
  readonly names: LocalizedText;
  readonly options: readonly AttributeOption[];
  /** Help text, page and search settings, the internal note and the order (package A2). */
  readonly display: AttributeDisplaySettings;
  readonly authorKind: CategoryAuthorKind;
  /** Null exactly when the author is the seed. */
  readonly authorAccountId: Id<'Account'> | null;
  readonly createdAt: Temporal.Instant;
}

/** A family (a "feature set" in the panel) with its current revision. */
export interface FeatureSetRecord {
  readonly id: Id<'AttributeFamily'>;
  readonly code: string;
  readonly status: string;
  readonly createdByKind: CategoryAuthorKind;
  readonly createdAt: Temporal.Instant;
  readonly revisionNo: number;
  readonly groups: readonly FamilyGroup[];
}

/** A field whose products are counted: its code, and whether its values live on the variants. */
export interface CountedField {
  readonly code: string;
  readonly isVariantOption: boolean;
}

/**
 * The admin reads of attributes and feature sets (attributes plan, package A1), all in a read-only
 * unit of the request's Market. A definition or family without a published revision (only possible
 * inside its creating unit) is left out. A product counts when its **published** revision carries
 * a value for the field: in its attribute values, or, for a variant option, on one of its variants.
 */
export interface AttributeAdminReader {
  /** Every definition of the Market, by code, at most `limit`. */
  definitions(market: MarketContext, limit: number): Promise<readonly AttributeDefinitionRecord[]>;

  /** One definition of the Market, or null. */
  definition(
    market: MarketContext,
    id: Id<'AttributeDefinition'>,
  ): Promise<AttributeDefinitionRecord | null>;

  /** The newest revisions of a definition, newest first, at most `limit`. */
  revisions(
    market: MarketContext,
    id: Id<'AttributeDefinition'>,
    limit: number,
  ): Promise<readonly AttributeRevisionRecord[]>;

  /** Every family of the Market, by code, at most `limit`. */
  featureSets(market: MarketContext, limit: number): Promise<readonly FeatureSetRecord[]>;

  /** One family of the Market, or null. */
  featureSet(market: MarketContext, id: Id<'AttributeFamily'>): Promise<FeatureSetRecord | null>;

  /** For each field, the products of the Market whose published revision carries a value. */
  productCounts(
    market: MarketContext,
    fields: readonly CountedField[],
  ): Promise<ReadonlyMap<string, number>>;

  /**
   * For each option code of a select or multi-select field, the products of the Market whose
   * published revision holds it.
   */
  optionProductCounts(
    market: MarketContext,
    field: CountedField & { readonly dataType: AttributeDataType },
    optionCodes: readonly string[],
  ): Promise<ReadonlyMap<string, number>>;

  /** For each family id, the products of the Market whose published revision uses that family. */
  featureSetProductCounts(
    market: MarketContext,
    ids: readonly Id<'AttributeFamily'>[],
  ): Promise<ReadonlyMap<string, number>>;
}

export const ATTRIBUTE_ADMIN_READER = Symbol('ATTRIBUTE_ADMIN_READER');
