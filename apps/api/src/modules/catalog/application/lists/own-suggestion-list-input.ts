import { ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import { listQueryInvalid, type ListQueryFailure } from '../../../../platform/list-query';
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
  readonly read: CatalogListRead<(typeof OWN_SUGGESTION_SORTS)[number]>;
}

/**
 * The query of a seller's own suggestion list: `status`, the label search `q`, `sort` (`created`,
 * `status`, `label`), `direction` (newest first by default), `page`, `pageSize` and `paging`. The
 * older cursor read (`afterId`, `limit`) stays for the current panel; it has no search, so a `q`
 * with it is refused rather than dropped.
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
  if (rawStatus !== undefined && rawStatus !== null) {
    if (typeof rawStatus !== 'string' || !(STATUSES as readonly string[]).includes(rawStatus)) {
      return listQueryInvalid('status', 'enum');
    }
    status = rawStatus as OwnSuggestionStatusFilter;
  }
  const { status: _status, ...rest } = record;
  void _status;
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
    return listQueryInvalid('q', 'conflict');
  }
  return ok({ status, read: read.value });
}
