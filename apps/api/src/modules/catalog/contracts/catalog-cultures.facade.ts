import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { CatalogValidationFailed } from './catalog.facade';

export { lineCultureOf } from '../domain/culture-visibility';
export type { LineCultureCandidate } from '../domain/culture-visibility';

/**
 * At most this many distinct Offers per visibility call (multi-culture package 3a): one search sync
 * batch, so the cultures and their category rows are read once per batch.
 */
export const MAX_VISIBILITY_OFFERS = 200;

/** Per Offer, the codes of the cultures it is visible in, by display order then code. */
export type OfferCultureCodes = ReadonlyMap<Id<'Offer'>, readonly string[]>;

/** The rule could not be evaluated: every Offer of the call is visible nowhere (fail closed). */
export interface CultureVisibilityUnavailable {
  readonly code: 'culture-visibility.unavailable';
}

/** At most this many distinct culture ids per call. */
export const MAX_CULTURE_IDS = 50;

/** What `sellers` needs to know of a culture: no description, no colour, no category marks. */
export interface CatalogCultureSummary {
  readonly id: Id<'Culture'>;
  readonly code: string;
  readonly status: 'draft' | 'active' | 'inactive';
  /** 0 to 9999; lists and the line rule ({@link lineCultureOf}) order by it, then by code. */
  readonly displayOrder: number;
  /** The certification type a member must hold a valid certificate of, or null. */
  readonly requiredCertificationType: string | null;
  readonly isDefault: boolean;
  /** Name by locale; the English one is always present. */
  readonly names: Readonly<Record<string, string>>;
}

/**
 * The culture read `sellers` needs (ADR-0047 decisions 1 and 3: `catalog` owns the cultures,
 * `sellers` owns the membership). Every method takes the caller's `CallContext` first, unchanged,
 * and is a thin call of one use case, so the gate runs.
 */
export interface CatalogCulturesFacade {
  /**
   * The cultures of the context's Market among the requested ids, in any status. An unknown id and
   * another Market's id are both absent from the answer, byte-identical. Rule `anonymous` (in-process
   * only; the caller names the ids). More than {@link MAX_CULTURE_IDS} distinct ids, or a malformed
   * one, is `validation.failed`, refused whole before any read. Not exposed over HTTP.
   */
  culturesByIds(
    context: CallContext,
    cultureIds: readonly Id<'Culture'>[],
  ): Promise<Result<readonly CatalogCultureSummary[], AccessDenied | CatalogValidationFailed>>;

  /**
   * Every ACTIVE culture of the context's Market, by display order then code (at most 200, the most
   * a Market holds). Rule `anonymous`, like {@link culturesByIds}; for the signup selection of a
   * seller (ADR-0048: "universal" means all Active cultures at that moment). Not exposed over HTTP.
   */
  activeCultures(
    context: CallContext,
  ): Promise<Result<readonly CatalogCultureSummary[], AccessDenied | CatalogValidationFailed>>;

  /**
   * The shared culture filter (multi-culture package 3a; ADR-0047 decisions 5 and 6, ADR-0048
   * security review M2): per requested Offer of the context's Market (at most
   * {@link MAX_VISIBILITY_OFFERS} distinct ids, else `validation.failed`), the codes of the ACTIVE
   * cultures it is visible in. An Offer is visible in a culture when its seller is approved there,
   * every platform category of its product is visible there, and, for a culture with a required
   * certification type, the seller holds a valid certificate of that type now and, unless every
   * category is "neutral", the Offer carries a tag of that type that `evaluateClaims` allows now.
   * An unknown, unpublished or other Market's Offer is absent (visible nowhere). Any failure is
   * `culture-visibility.unavailable` for the whole call: a buyer read treats it as visible nowhere,
   * the search index retries. Reads sellers and certification through their facades only (no
   * cross-schema join). Nothing is cached. The `culture_codes` of the search index are built from
   * it. Two use cases: `anonymous` for request actors, `system` for handlers and jobs. In process
   * only; not exposed over HTTP.
   */
  visibleCultureCodesForOffers(
    context: CallContext,
    offerIds: readonly Id<'Offer'>[],
  ): Promise<
    Result<OfferCultureCodes, AccessDenied | CatalogValidationFailed | CultureVisibilityUnavailable>
  >;

  /**
   * Whether one Offer is visible in at least one of the given cultures (ADR-0047 decision 5: "a
   * buyer sees an Offer when at least one chosen culture makes it visible"), through
   * {@link visibleCultureCodesForOffers}. Fail closed: any failure, an empty or malformed list, an
   * unknown code and an unknown Offer answer `false`. For a single-Offer read, the cart and
   * checkout (package 3b and 7). In process only.
   */
  isOfferVisibleIn(
    context: CallContext,
    offerId: Id<'Offer'>,
    cultureCodes: readonly string[],
  ): Promise<boolean>;
}

/** Nest token of the {@link CatalogCulturesFacade}, provided and exported by `CatalogModule`. */
export const CATALOG_CULTURES_FACADE = Symbol('CATALOG_CULTURES_FACADE');
