import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { AttributeDefinitionStatus, LocalizedText } from '../../domain/attribute-definition';
import type { VariantTypeSettingsContent } from '../../domain/variant-type-settings';

/** One option of a variant type, from the definition's published revision. */
export interface VariantTypeOptionRecord {
  readonly code: string;
  readonly labels: LocalizedText;
  readonly active: boolean;
  readonly position: number;
}

/**
 * A variant type (variants V6): an attribute definition whose published revision is a variant
 * option and which is not archived, with its stored display settings (or the defaults).
 */
export interface VariantTypeRecord {
  readonly id: Id<'AttributeDefinition'>;
  readonly code: string;
  readonly status: Exclude<AttributeDefinitionStatus, 'archived'>;
  readonly names: LocalizedText;
  readonly options: readonly VariantTypeOptionRecord[];
  readonly settings: VariantTypeSettingsContent;
  /** The version of the stored settings; 0 while the type uses the defaults. */
  readonly settingsVersion: number;
}

/** A feature set (attribute family) that offers a variant type as a variant option. */
export interface VariantTypeFeatureSet {
  readonly id: Id<'AttributeFamily'>;
  readonly code: string;
  readonly names: LocalizedText;
}

/**
 * The ready-made issue filters of the Variants tab (plan section 9) that catalog answers. "Out of
 * stock everywhere" is not one: stock is inventory's, and catalog reads no stock (ADR-0024
 * decision 5); the page asks inventory for it.
 */
export const VARIANT_ISSUES = [
  'no-seller-selling',
  'missing-gtin',
  'duplicate-gtin',
  'no-image',
  'missing-language',
] as const;
export type VariantIssue = (typeof VARIANT_ISSUES)[number];

/** What the Variants tab and its export ask for. */
export interface VariantsQuery {
  /** Product name (in `locale`), product or variant code, GTIN digits or seller SKU; null: all. */
  readonly text: string | null;
  /** Only variants that carry a value of this variant type; null: all. */
  readonly typeCode: string | null;
  readonly issue: VariantIssue | null;
  /** The variant id the previous page ended on (newest first); null: the first page. */
  readonly after: string | null;
  readonly limit: number;
  /** The Market's default locale: names are searched and shown in it. */
  readonly locale: string;
  /** Every supported locale: a variant label missing in one is `missing-language`. */
  readonly locales: readonly string[];
}

/** One variant of a live (published, possibly paused) product, as the Variants tab shows it. */
export interface VariantRow {
  readonly productId: Id<'Product'>;
  readonly productCode: string;
  /** In the default locale; null when the published revision has no name in it. */
  readonly productName: string | null;
  readonly productScope: 'PLATFORM' | 'SELLER';
  /** The admin pause (catalog design 4.1a) takes every variant of the product off sale. */
  readonly productPaused: boolean;
  readonly variantId: Id<'Variant'>;
  readonly variantNo: number;
  readonly variantCode: string;
  readonly labels: LocalizedText;
  /** 14 digits, or null when none is given. */
  readonly gtin: string | null;
  /** Another live variant of the Market carries the same GTIN. */
  readonly duplicateGtin: boolean;
  /** Listed Offers of the product (each sells every variant until per-variant selling, V5). */
  readonly sellers: number;
  /** The variant's own photo picks (V4). */
  readonly ownImages: number;
  /** The photos of the product's published revision. */
  readonly productImages: number;
  /** Supported locales the variant's label lacks. */
  readonly missingLocales: readonly string[];
}

export interface VariantsPage {
  readonly rows: readonly VariantRow[];
  /** Pass as `after` for the next page; null at the end. */
  readonly nextAfter: string | null;
}

/**
 * The reads behind the admin Catalogue > Variants page (variants V6). Catalog tables only: no
 * price and no stock (ADR-0024 decision 5). Every method runs in the open read-only unit of the
 * use case through the Market-scoped client.
 */
export interface VariantAdminReader {
  /** The Market's variant types, by code, at most `limit`. */
  variantTypes(market: MarketContext, limit: number): Promise<readonly VariantTypeRecord[]>;

  /** One variant type, or null when the id names no variant type of this Market. */
  variantType(
    market: MarketContext,
    id: Id<'AttributeDefinition'>,
  ): Promise<VariantTypeRecord | null>;

  /**
   * Per code: live products whose published revision has a variant with a value of it, and those
   * live variants.
   */
  typeCounts(
    market: MarketContext,
    codes: readonly string[],
  ): Promise<ReadonlyMap<string, { readonly products: number; readonly liveVariants: number }>>;

  /** Per option code of one variant type: live products with a variant of that option. */
  optionProductCounts(
    market: MarketContext,
    code: string,
    optionCodes: readonly string[],
  ): Promise<ReadonlyMap<string, number>>;

  /** Per code: the published feature sets that offer it as a variant option. */
  featureSetsUsing(
    market: MarketContext,
    codes: readonly string[],
  ): Promise<ReadonlyMap<string, readonly VariantTypeFeatureSet[]>>;

  /** One page of live variants, newest first. */
  variantsPage(market: MarketContext, query: VariantsQuery): Promise<VariantsPage>;

  /** How many live variants each issue filter holds, with the same type filter. */
  issueCounts(
    market: MarketContext,
    query: Pick<VariantsQuery, 'typeCode' | 'locales'>,
  ): Promise<Readonly<Record<VariantIssue, number>>>;
}

export const VARIANT_ADMIN_READER = Symbol('VARIANT_ADMIN_READER');
