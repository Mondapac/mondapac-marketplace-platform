// The /review queue page: its URL parameters, the API query they become, and the links that
// change one of them. Pure, so the page and its filters share one reading of the URL.

export type QueueTab = 'revision' | 'offer';
export type ChangeFilter = 'all' | 'new' | 'update';
export type PhotoFilter = 'any' | 'with';

export interface QueueParams {
  readonly tab: QueueTab;
  /** Revisions only: a first publication (new) or a change to a published product (update). */
  readonly change: ChangeFilter;
  /** Revisions only: the pending revision lists any photo. */
  readonly photos: PhotoFilter;
  /** One seller's rows; an id, never a name. */
  readonly seller: string | null;
  /** The keyset cursor of the page. */
  readonly after: string | null;
}

export const QUEUE_PAGE_SIZE = 25;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The API's cursor: the submit instant (ms) and the id of the page's last row.
const CURSOR = /^\d{1,15}_[0-9a-f-]{36}$/;

type Raw = Readonly<Record<string, string | readonly string[] | undefined>>;

function one(raw: Raw, key: string): string | null {
  const value = raw[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Reads the URL; a value it does not know falls back to the default instead of failing. */
export function parseQueueParams(raw: Raw): QueueParams {
  const tab = one(raw, 'type') === 'offer' ? 'offer' : 'revision';
  const change = one(raw, 'change');
  const seller = one(raw, 'seller');
  const after = one(raw, 'after');
  return {
    tab,
    change: tab === 'revision' && (change === 'new' || change === 'update') ? change : 'all',
    photos: tab === 'revision' && one(raw, 'photos') === 'with' ? 'with' : 'any',
    seller: seller !== null && UUID.test(seller) ? seller.toLowerCase() : null,
    after: after !== null && CURSOR.test(after) ? after : null,
  };
}

/** The GET catalog/admin/review-queue query of a page. */
export function apiQueryOf(params: QueueParams): string {
  const query = new URLSearchParams({
    kind: params.tab === 'offer' ? 'offer-first-publication' : 'product-revision',
    limit: String(QUEUE_PAGE_SIZE),
  });
  if (params.seller !== null) query.set('sellerId', params.seller);
  if (params.tab === 'revision') {
    if (params.change !== 'all') {
      query.set('firstPublication', params.change === 'new' ? 'true' : 'false');
    }
    if (params.photos === 'with') query.set('hasImages', 'true');
  }
  if (params.after !== null) query.set('afterId', params.after);
  return query.toString();
}

/** True when any filter (not the tab or page) narrows the list. */
export function isFiltered(params: QueueParams): boolean {
  return params.change !== 'all' || params.photos !== 'any' || params.seller !== null;
}

/**
 * The link to the queue with `change` applied. A new filter or tab starts from the first page;
 * only `after` itself keeps the filters.
 */
export function queueHref(params: QueueParams, change: Partial<QueueParams> = {}): string {
  const next: QueueParams = { ...params, after: null, ...change };
  const query = new URLSearchParams();
  if (next.tab === 'offer') query.set('type', 'offer');
  if (next.tab === 'revision' && next.change !== 'all') query.set('change', next.change);
  if (next.tab === 'revision' && next.photos === 'with') query.set('photos', 'with');
  if (next.seller !== null) query.set('seller', next.seller);
  if (next.after !== null) query.set('after', next.after);
  const text = query.toString();
  return text === '' ? '/review' : `/review?${text}`;
}

/** The queue with no filter, on the same tab. */
export function clearedHref(params: QueueParams): string {
  return queueHref(params, { change: 'all', photos: 'any', seller: null });
}
