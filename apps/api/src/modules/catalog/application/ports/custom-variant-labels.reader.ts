import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { LabelDifference } from '../../domain/variant-labels';

/** One variant of a published revision whose stored label is not the automatic one. */
export interface CustomVariantLabelRow {
  readonly productId: Id<'Product'>;
  readonly productCode: string;
  readonly variantId: Id<'Variant'>;
  readonly variantNo: number;
  readonly variantCode: string;
  readonly differences: readonly LabelDifference[];
}

export interface CustomVariantLabelsPage {
  readonly rows: readonly CustomVariantLabelRow[];
  /** Pass as `afterId` to continue; null when the scan reached the end. */
  readonly nextAfterId: string | null;
}

/**
 * The read behind the "Custom variant labels" report (variants V2): variants of the PUBLISHED
 * revision of each product of the Market whose stored label differs from the one the builder
 * gives from the revision's pinned option labels. Catalog tables only. Runs in the open
 * (read-only) unit of the use case.
 */
export interface CustomVariantLabelsReader {
  /** At most `limit` differing variants after `afterId` (variant id order); bounded scan. */
  page(
    market: MarketContext,
    query: {
      readonly afterId: string | null;
      readonly limit: number;
      readonly locales: readonly string[];
    },
  ): Promise<CustomVariantLabelsPage>;
}

export const CUSTOM_VARIANT_LABELS_READER = Symbol('CUSTOM_VARIANT_LABELS_READER');
