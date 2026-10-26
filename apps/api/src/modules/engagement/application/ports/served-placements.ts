import type { CallContext, Id } from '@mondapac/shared-kernel';

/**
 * Which storefront placements are served now (storefront's public contract, behind a port so the
 * application layer imports no other module). Ids only.
 */
export interface ServedPlacements {
  /**
   * The ids of the placements buyers are served now on the page, in the call's Market; empty for
   * a page that is unknown, unpublished, archived or not live, or that storefront cannot answer
   * for, so nothing is counted for it.
   */
  of(context: CallContext, pageId: Id<'StorefrontPage'>): Promise<ReadonlySet<string>>;
}

export const SERVED_PLACEMENTS = Symbol('SERVED_PLACEMENTS');
