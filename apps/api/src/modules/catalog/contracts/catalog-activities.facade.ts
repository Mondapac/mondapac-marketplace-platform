import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { CatalogValidationFailed } from './catalog.facade';

/** At most this many distinct activity ids per call (a seller carries at most ten). */
export const MAX_ACTIVITY_IDS = 20;

/**
 * The business-activity read `sellers` needs (ADR-0040 decision 4: `catalog` owns the activities,
 * `sellers` owns the assignment). Every method takes the caller's `CallContext` first, unchanged,
 * and is a thin call of one use case, so the gate runs.
 */
export interface CatalogActivitiesFacade {
  /**
   * Which of the requested activity ids exist in the context's Market and are ACTIVE. An unknown
   * id, another Market's id and an inactive activity are all absent from the answer,
   * byte-identical. Rule `anonymous` (ids only, no name or scope is returned). More than
   * {@link MAX_ACTIVITY_IDS} distinct ids, or a malformed one, is `validation.failed`, refused
   * whole before any read. In-process only; not exposed over HTTP.
   */
  activeBusinessActivityIds(
    context: CallContext,
    activityIds: readonly Id<'BusinessActivity'>[],
  ): Promise<Result<ReadonlySet<Id<'BusinessActivity'>>, AccessDenied | CatalogValidationFailed>>;
}

/** Nest token of the {@link CatalogActivitiesFacade}, provided and exported by `CatalogModule`. */
export const CATALOG_ACTIVITIES_FACADE = Symbol('CATALOG_ACTIVITIES_FACADE');
