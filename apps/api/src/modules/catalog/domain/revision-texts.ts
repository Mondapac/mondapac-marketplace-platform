import type { Result } from '@mondapac/shared-kernel';
import { draftTextsOf, type DraftText } from './draft-texts';
import type { RevisionSummary } from './product-revision-policy';
import type { RevisionContent } from './revision-content';

/**
 * The customer-facing texts of a frozen revision with their places (catalog design 6, 4.2 row 1):
 * the submit and publish checks run over these, so what is checked is what the revision stores.
 * It reads the content through the same closed walk as a draft ({@link draftTextsOf}), so the
 * list of checked fields is one list for both.
 */
export function revisionTextsOf(
  content: RevisionContent,
  supportedLocales: readonly string[],
  defaultLocale: string,
): Result<DraftText[], { readonly code: 'working-copy.invalid-content' }> {
  return draftTextsOf(
    {
      texts: content.texts,
      categoryIds: content.categoryIds,
      topicIds: content.topicIds,
      taxCategoryCode: content.taxCategoryCode,
      attributeValues: content.attributeValues,
      variants: content.variants.map((variant) => ({
        variantId: variant.variantId,
        optionValues: variant.optionValues,
        labels: variant.labels,
      })),
      imageIds: content.imageIds,
    },
    supportedLocales,
    defaultLocale,
    'revision',
  );
}

/** What `ProductRevisionPolicy` reads of a revision's content (4.3). */
export function summaryOf(content: RevisionContent): RevisionSummary {
  return {
    names: Object.fromEntries(
      Object.entries(content.texts).map(([locale, text]) => [locale, text.name]),
    ),
    categoryIds: content.categoryIds,
    topicIds: content.topicIds,
    taxCategoryCode: content.taxCategoryCode,
    imageIds: content.imageIds,
    variantIds: content.variants.map((variant) => variant.variantId),
    variantGtins: Object.fromEntries(
      content.variants.map((variant) => [variant.variantId, variant.gtin] as const),
    ),
    variantAxes: [
      ...new Set(content.variants.flatMap((variant) => Object.keys(variant.optionValues))),
    ],
  };
}
