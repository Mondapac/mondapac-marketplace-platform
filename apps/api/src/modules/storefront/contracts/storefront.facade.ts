import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

/**
 * What other modules may ask `storefront`. Read-only: nothing here changes a page, and nothing
 * about a shopper is known to storefront.
 */
export interface StorefrontFacade {
  /**
   * The ids of the placements (the module placements of a page) that buyers are served right now
   * on the page `pageId` in the context's Market: the enabled placements of the page's published
   * version, when the page is live (not archived, inside its live window). Empty for an unknown
   * page, a page of another Market, a page with no published version and an archived or
   * not-yet-live page, so the caller cannot tell those apart. Ids only; no module settings.
   * Rule `anonymous`.
   */
  servedPlacements(
    context: CallContext,
    pageId: Id<'StorefrontPage'>,
  ): Promise<Result<ReadonlySet<string>, AccessDenied>>;
}

/** Nest token of the {@link StorefrontFacade}, provided and exported by `StorefrontModule`. */
export const STOREFRONT_FACADE = Symbol('STOREFRONT_FACADE');
