import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

/**
 * What reporting's nightly snapshot reads of search (dashboards v2, phase 2): the folded texts the
 * storefront search found nothing for in a window. Rule `system`; not exposed over HTTP. Texts
 * only, never who searched.
 */
export interface SearchReportingFacade {
  /**
   * The folded texts (lower case, 2 to 50 characters) of plain text searches whose first page
   * showed nothing in `window` (at most 26 hours), those seen in the most quarter hours first, at
   * most 2,000.
   */
  zeroResultTexts(
    context: CallContext,
    request: {
      readonly window: { readonly from: Temporal.Instant; readonly to: Temporal.Instant };
    },
  ): Promise<
    Result<
      { readonly texts: readonly string[] },
      AccessDenied | { readonly code: 'validation.failed' }
    >
  >;
}

/** Nest token of the {@link SearchReportingFacade}, provided and exported by `SearchModule`. */
export const SEARCH_REPORTING_FACADE = Symbol('SEARCH_REPORTING_FACADE');
