import {
  closedListPayloadParser,
  type ClosedListPayload,
  type ListDefinition,
} from '../../../lists';
import { SELLERS_SAVED_FILTER_SHARE, SELLERS_SELLER_VIEW } from '../../contracts/permissions';
import { SELLER_HEALTH_METRICS } from '../../domain/seller-health';
import {
  AREA_CODE,
  isStateTab,
  LIST_KINDS,
  LIST_TABS,
  type ListTab,
} from '../../domain/seller-list';

// The lists sellers registers with `lists` (super list phase 3) so they have saved filters through
// the generic routes: the Sellers list (list 15) and the "Needs a look" health queue (list 16).
// Both are guarded by `sellers.seller.view`, the key their list routes check, and shared with the
// module's share key. The vocabulary mirrors what each list route accepts, so a saved filter
// always opens; search text is never saved.

type Problem = { readonly path: string; readonly code: string };

/** A health score as the queue's `minScore`/`maxScore` take it: a whole number 0 to 100. */
const SCORE = /^(100|[1-9]?[0-9])$/;

const HEALTH_QUEUE: ListDefinition = {
  listKey: 'admin.sellers.health-queue',
  population: 'admin',
  viewKey: SELLERS_SELLER_VIEW.key,
  shareKey: SELLERS_SAVED_FILTER_SHARE.key,
  parsePayload: closedListPayloadParser({
    // All unhealthy sellers, then one view per lowest health measure.
    views: ['all', ...SELLER_HEALTH_METRICS],
    defaultView: 'all',
    filters: [
      ['minScore', { kind: 'text', pattern: SCORE }],
      ['maxScore', { kind: 'text', pattern: SCORE }],
    ],
    sorts: ['score', 'name', 'day'],
    check: ({ filters }) => {
      const min = filters?.['minScore'];
      const max = filters?.['maxScore'];
      return typeof min === 'string' && typeof max === 'string' && Number(min) > Number(max)
        ? [{ path: 'payload.filters.maxScore', code: 'range' }]
        : [];
    },
  }),
};

/**
 * The rules of the Sellers list route that tie a filter or an order to a tab: `kind` belongs to
 * Awaiting review, `outsideArea` to Incomplete, `areaCode` to the tabs read from the seller files,
 * and a state tab is listed by `identity` newest first only (sort `queue`, direction `desc`).
 */
function sellerListProblems(payload: ClosedListPayload): readonly Problem[] {
  const tab = payload.view as ListTab;
  const filters = payload.filters ?? {};
  const problems: Problem[] = [];
  if (filters['kind'] !== undefined && tab !== 'awaiting-review') {
    problems.push({ path: 'payload.filters.kind', code: 'outside-view' });
  }
  if (filters['outsideArea'] !== undefined && tab !== 'incomplete') {
    problems.push({ path: 'payload.filters.outsideArea', code: 'outside-view' });
  }
  if (filters['areaCode'] !== undefined && isStateTab(tab)) {
    problems.push({ path: 'payload.filters.areaCode', code: 'outside-view' });
  }
  if (isStateTab(tab)) {
    if (payload.sort !== undefined && payload.sort !== 'queue') {
      problems.push({ path: 'payload.sort', code: 'outside-view' });
    }
    if (payload.direction !== undefined && payload.direction !== 'desc') {
      problems.push({ path: 'payload.direction', code: 'outside-view' });
    }
  }
  return problems;
}

const SELLER_LIST: ListDefinition = {
  listKey: 'admin.sellers.list',
  population: 'admin',
  viewKey: SELLERS_SELLER_VIEW.key,
  shareKey: SELLERS_SAVED_FILTER_SHARE.key,
  parsePayload: closedListPayloadParser({
    views: LIST_TABS,
    // A document that names no view means `all`, as the list route reads a request without one.
    defaultView: 'all',
    filters: [
      ['kind', { kind: 'word', values: LIST_KINDS }],
      ['outsideArea', { kind: 'flag' }],
      ['areaCode', { kind: 'text', pattern: AREA_CODE }],
    ],
    sorts: ['queue', 'name'],
    check: sellerListProblems,
  }),
};

export const SELLERS_LISTS: readonly ListDefinition[] = [SELLER_LIST, HEALTH_QUEUE];
