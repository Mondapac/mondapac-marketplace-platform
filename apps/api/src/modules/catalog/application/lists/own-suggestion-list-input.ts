import { ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import {
  listQueryInvalid,
  parseNamedInstantRange,
  type InstantRange,
  type ListQueryFailure,
} from '../../../../platform/list-query';
import { OWN_SUGGESTION_SORTS } from '../ports/own-suggestion-page';
import { readCatalogListInput, type CatalogListRead } from './catalog-list-input';

export const OWN_SUGGESTION_PAGE_DEFAULT = 25;
export const OWN_SUGGESTION_PAGE_MAX = 50;
export const OWN_SUGGESTION_MAX_PAGE = 100;

const STATUSES = ['open', 'approved', 'mapped', 'rejected'] as const;
export type OwnSuggestionStatusFilter = (typeof STATUSES)[number];

const KEYS = [
  'status',
  'q',
  'search',
  'createdFrom',
  'createdTo',
  'sort',
  'direction',
  'page',
  'pageSize',
  'paging',
  'afterId',
  'limit',
];

export interface OwnSuggestionListRead {
  readonly status: OwnSuggestionStatusFilter | null;
  /** The created range: `createdFrom` inclusive, `createdTo` exclusive. */
  readonly created: InstantRange;
  readonly read: CatalogListRead<(typeof OWN_SUGGESTION_SORTS)[number]>;
}

/**
 * The query of a seller's own suggestion list: `status`, the label search `q`, `sort` (`created`,
 * `status`, `label`), `direction` (newest first by default), `page`, `pageSize` and `paging`. The
 * older cursor read (`afterId`, `limit`) stays for the current panel; it has no search, so a `q`
 * with it, or with a created range, is refused rather than dropped.
 */
export function readOwnSuggestionList(
  input: unknown,
  cursorIdOf: (value: unknown) => string | null,
): Result<OwnSuggestionListRead, ListQueryFailure> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return listQueryInvalid('query', 'type');
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!KEYS.includes(key)) return listQueryInvalid(key, 'unknown');
  }
  let status: OwnSuggestionStatusFilter | null = null;
  const rawStatus = record['status'];
  if (rawStatus !== undefined && rawStatus !== null && rawStatus !== '') {
    if (typeof rawStatus !== 'string' || !(STATUSES as readonly string[]).includes(rawStatus)) {
      return listQueryInvalid('status', 'enum');
    }
    status = rawStatus as OwnSuggestionStatusFilter;
  }
  const created = parseNamedInstantRange(record, 'createdFrom', 'createdTo');
  if (!created.ok) return created;
  const { status: _status, createdFrom: _from, createdTo: _to, ...rest } = record;
  void _status;
  void _from;
  void _to;
  const read = readCatalogListInput(rest, {
    sorts: OWN_SUGGESTION_SORTS,
    defaultSort: 'created',
    defaultDirection: (sort) => (sort === 'created' ? 'desc' : 'asc'),
    pageDefault: OWN_SUGGESTION_PAGE_DEFAULT,
    pageMax: OWN_SUGGESTION_PAGE_MAX,
    maxPage: OWN_SUGGESTION_MAX_PAGE,
    cursorIdOf,
  });
  if (!read.ok) return read;
  if (read.value.mode === 'cursor' && read.value.q !== null) {
    return listQueryInvalid(record['q'] === undefined ? 'search' : 'q', 'conflict');
  }
  if (read.value.mode === 'cursor' && (created.value.from !== null || created.value.to !== null)) {
    return listQueryInvalid(created.value.from !== null ? 'createdFrom' : 'createdTo', 'conflict');
  }
  return ok({ status, created: created.value, read: read.value });
}
