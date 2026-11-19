import {
  closedListPayloadParser,
  SAVED_DATE_PRESETS,
  type ClosedFilterRule,
  type ListDefinition,
} from '../../../lists';
import {
  CERTIFICATION_ISSUER_VIEW,
  CERTIFICATION_SAVED_FILTER_SHARE,
  CERTIFICATION_SELLER_CERTIFICATE_VIEW,
} from '../../contracts/permissions';
import { SUBMISSION_KINDS } from '../../domain/events';

// The lists certification registers with `lists` (super list phase 3) so they have saved filters
// through the generic routes: Issuer requests (list 36) and the certificate review queue (list
// 17). The vocabulary mirrors what each panel sends and what its list route accepts; each view key
// is the key that list's route checks, and a filter is shared with the module's share key. Search
// text and the seller link (`sellerId`) are never saved.

/** A certification type code as the list's `type` filter takes it. */
const TYPE_CODE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const FILTERS: readonly (readonly [string, ClosedFilterRule])[] = [
  ['type', { kind: 'text', pattern: TYPE_CODE }],
  ['submitted', { kind: 'word', values: SAVED_DATE_PRESETS }],
];

const ISSUER_REQUESTS: ListDefinition = {
  listKey: 'admin.certification.issuer-requests',
  population: 'admin',
  viewKey: CERTIFICATION_ISSUER_VIEW.key,
  shareKey: CERTIFICATION_SAVED_FILTER_SHARE.key,
  parsePayload: closedListPayloadParser({
    views: ['all'],
    defaultView: 'all',
    filters: FILTERS,
    sorts: ['submitted', 'type'],
  }),
};

const REVIEW_QUEUE: ListDefinition = {
  listKey: 'admin.certification.review-queue',
  population: 'admin',
  viewKey: CERTIFICATION_SELLER_CERTIFICATE_VIEW.key,
  shareKey: CERTIFICATION_SAVED_FILTER_SHARE.key,
  parsePayload: closedListPayloadParser({
    // Every waiting submission, then one view per kind of submission.
    views: ['all', ...SUBMISSION_KINDS],
    defaultView: 'all',
    filters: FILTERS,
    sorts: ['queue', 'submitted', 'type'],
  }),
};

export const CERTIFICATION_LISTS: readonly ListDefinition[] = [ISSUER_REQUESTS, REVIEW_QUEUE];
