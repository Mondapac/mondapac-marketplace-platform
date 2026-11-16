import { ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import {
  listQueryInvalid,
  parseListQuery,
  type ListQuery,
  type ListQueryFailure,
} from '../../../../platform/list-query';

/** The longest search text of a catalog list, in code points. */
export const LIST_TEXT_MAX = 100;

const PAGE_KEYS = ['sort', 'direction', 'page', 'pageSize', 'paging'] as const;

const absent = (value: unknown): boolean => value === undefined || value === null || value === '';

export interface CatalogListSpec<S extends string> {
  readonly sorts: readonly S[];
  readonly defaultSort: S;
  readonly defaultDirection: (sort: S) => 'asc' | 'desc';
  readonly pageDefault: number;
  readonly pageMax: number;
  /** The highest page number; keeps `page * pageSize` within the paged rows cap. */
  readonly maxPage: number;
  /** The id of a cursor value, or null when it is not one. */
  readonly cursorIdOf: (value: unknown) => string | null;
}

export type CatalogListRead<S extends string> =
  | {
      readonly mode: 'cursor';
      readonly q: string | null;
      readonly afterId: string | null;
      readonly limit: number;
    }
  | { readonly mode: 'page'; readonly q: string | null; readonly paged: ListQuery<S> };

/**
 * The shared reading of the search text and the paging of the catalog admin lists that began as
 * cursor lists (brands, business activities, tags). The text is `q`; the older name `search` is an
 * alias (both together conflict). The older cursor read (`afterId`, `limit`) and the page read
 * (`sort`, `direction`, `page`, `pageSize`, `paging`) do not mix; a bare `limit` stays a cursor
 * read so the current panel is not changed by this.
 */
export function readCatalogListInput<S extends string>(
  body: Readonly<Record<string, unknown>>,
  spec: CatalogListSpec<S>,
): Result<CatalogListRead<S>, ListQueryFailure> {
  if (!absent(body['q']) && !absent(body['search'])) return listQueryInvalid('search', 'conflict');
  const rawText = absent(body['q']) ? body['search'] : body['q'];
  const textPath = absent(body['q']) ? 'search' : 'q';
  let q: string | null = null;
  if (!absent(rawText)) {
    if (typeof rawText !== 'string') return listQueryInvalid(textPath, 'type');
    const trimmed = rawText.trim();
    if ([...trimmed].length > LIST_TEXT_MAX) return listQueryInvalid(textPath, 'length');
    if (/\p{Cc}/u.test(trimmed)) return listQueryInvalid(textPath, 'format');
    q = trimmed === '' ? null : trimmed;
  }
  if (['afterId', 'limit'].some((key) => !absent(body[key]))) {
    const mixed = PAGE_KEYS.find((key) => !absent(body[key]));
    if (mixed !== undefined) return listQueryInvalid(mixed, 'conflict');
    let afterId: string | null = null;
    if (!absent(body['afterId'])) {
      afterId = spec.cursorIdOf(body['afterId']);
      if (afterId === null) return listQueryInvalid('afterId', 'format');
    }
    let limit = spec.pageDefault;
    const rawLimit = body['limit'];
    if (!absent(rawLimit)) {
      if (
        typeof rawLimit !== 'number' ||
        !Number.isInteger(rawLimit) ||
        rawLimit < 1 ||
        rawLimit > spec.pageMax
      ) {
        return listQueryInvalid('limit', 'range');
      }
      limit = rawLimit;
    }
    return ok({ mode: 'cursor', q, afterId, limit });
  }
  const paged = parseListQuery(body, {
    sorts: spec.sorts,
    defaultSort: spec.defaultSort,
    defaultDirection: spec.defaultDirection,
    defaultPageSize: spec.pageDefault,
    maxPageSize: spec.pageMax,
    maxPage: spec.maxPage,
  });
  if (!paged.ok) return paged;
  return ok({ mode: 'page', q, paged: paged.value });
}
