// The /review queue page: which of its two lists the URL opens, and the link to one product
// version review. Pure, so server and client code share one reading of the URL.

export type QueueTab = 'revision' | 'offer';

/** `?type=offer` opens the Offers list (the dashboard links there); anything else, the revisions. */
export function parseQueueTab(
  raw: Readonly<Record<string, string | readonly string[] | undefined>>,
): QueueTab {
  return raw['type'] === 'offer' ? 'offer' : 'revision';
}

/** The queue page with one list open. */
export const queueHref = (tab: QueueTab): string =>
  tab === 'offer' ? '/review?type=offer' : '/review';

/** The page of one product version review (server and client code both build it). */
export const revisionHref = (row: {
  readonly productId: string;
  readonly revisionId: string;
}): string => `/review/products/${row.productId}/revisions/${row.revisionId}`;
