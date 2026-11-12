import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { CatalogValidationFailed } from './catalog.facade';

/** At most this many distinct culture ids per call. */
export const MAX_CULTURE_IDS = 50;

/** What `sellers` needs to know of a culture: no description, no colour, no category marks. */
export interface CatalogCultureSummary {
  readonly id: Id<'Culture'>;
  readonly code: string;
  readonly status: 'draft' | 'active' | 'inactive';
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
}

/** Nest token of the {@link CatalogCulturesFacade}, provided and exported by `CatalogModule`. */
export const CATALOG_CULTURES_FACADE = Symbol('CATALOG_CULTURES_FACADE');
