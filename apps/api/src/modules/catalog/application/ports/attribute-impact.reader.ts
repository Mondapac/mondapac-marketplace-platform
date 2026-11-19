import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { LocalizedText } from '../../domain/attribute-definition';

/**
 * A count that may be cut short: when `atLeast` is true the real number is `count` or more (the
 * read stopped at its cap, so the dialog says "at least {count}", attributes A8).
 */
export interface CappedCount {
  readonly count: number;
  readonly atLeast: boolean;
}

export interface ImpactedFeatureSet {
  readonly id: Id<'AttributeFamily'>;
  readonly code: string;
  readonly names: LocalizedText;
}

/** What a change of an attribute reaches (attributes A8, the impact dialog). */
export interface AttributeImpact {
  /** Products whose published revision carries a value for the attribute. */
  readonly publishedProducts: CappedCount;
  /** Products whose draft (working copy) carries a value for the attribute. */
  readonly drafts: CappedCount;
  /** Active feature sets whose published revision lists the attribute, all of them. */
  readonly featureSetCount: number;
  /** The first of them by code, at most `FEATURE_SET_LIST_MAX`. */
  readonly featureSets: readonly ImpactedFeatureSet[];
  /** Categories whose published feature-set link names one of those feature sets. */
  readonly categories: CappedCount;
  /** Categories whose published filter list names the attribute. */
  readonly filters: CappedCount;
  /** For a variant attribute: published products whose variants carry a value. Else zero. */
  readonly liveVariantProducts: CappedCount;
}

export const FEATURE_SET_LIST_MAX = 50;
export const IMPACT_COUNT_CAP = 10_000;

/**
 * The reads behind the impact dialog and the archive checks (attributes A8), in a read-only or
 * writing unit of the request's Market. Counts stop at {@link IMPACT_COUNT_CAP} and say so.
 */
export interface AttributeImpactReader {
  impactOf(
    market: MarketContext,
    attribute: { readonly code: string; readonly isVariantOption: boolean },
  ): Promise<AttributeImpact>;
}

export const ATTRIBUTE_IMPACT_READER = Symbol('ATTRIBUTE_IMPACT_READER');
