import { Logger } from '@nestjs/common';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import {
  type DocumentCursor,
  DOCUMENT_KINDS,
  DOCUMENT_SORT_KEYS,
  documentRowActions,
  type DocumentListFilter,
  type DocumentListPage,
  type DocumentListRecord,
  type DocumentSort,
} from '../domain/admin-document-list';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import { settled } from './order-labels';
import type { AdminDocumentListReader } from './ports/admin-document-list.reader';
import type { OrderLabels } from './ports/order-labels';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_PAGED_ROWS,
  MAX_SEARCH_LENGTH,
  MIN_SEARCH_LENGTH,
  type ListScope,
  type ReadFailure,
} from './read-flow';

const logger = new Logger('AdminDocumentList');

export interface AdminDocumentListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly documents: AdminDocumentListReader;
  readonly labels: OrderLabels;
}

/** The query of the admin Invoices list; every field is optional and checked here. */
export interface DocumentListInput {
  /** `order-confirmation` (default) or `credit-note`: one tab at a time. */
  readonly kind?: unknown;
  readonly page?: unknown;
  readonly pageSize?: unknown;
  /**
   * Previous/Next paging (List paging `prev-next`, and past row 10,000): `limit` rows from 1 to
   * 100, after `cursor` (the `nextCursor` of the page before). Newest first only; no `page`,
   * `pageSize`, `sort` or `direction` with it.
   */
  readonly cursor?: unknown;
  readonly limit?: unknown;
  readonly sort?: unknown;
  readonly direction?: unknown;
  /** An order, seller order, credit note or refund id, exact. */
  readonly q?: unknown;
  readonly search?: unknown;
  readonly sellerId?: unknown;
  readonly from?: unknown;
  readonly to?: unknown;
  readonly minAmount?: unknown;
  readonly maxAmount?: unknown;
}

const AMOUNT = /^[0-9]{1,15}$/;

/** A cursor is `<issued-at ms>.<document id>`: opaque to callers, checked on the way in. */
export const encodeDocumentCursor = (row: DocumentCursor): string =>
  `${row.issuedAt.epochMilliseconds}.${row.documentId}`;

function decodeCursor(value: unknown): DocumentCursor | null {
  const match = typeof value === 'string' ? /^([0-9]{1,15})\.([0-9a-f-]{36})$/.exec(value) : null;
  const id = match === null ? null : parseId(match[2]!);
  if (match === null || id === null || !id.ok) return null;
  return {
    issuedAt: Temporal.Instant.fromEpochMilliseconds(Number(match[1])),
    documentId: id.value,
  };
}

type Paging =
  | { readonly kind: 'pages'; readonly page: number; readonly pageSize: number }
  | { readonly kind: 'prev-next'; readonly after: DocumentCursor | null; readonly limit: number };

interface Parsed {
  readonly filter: DocumentListFilter;
  readonly search: string | null;
  readonly sort: DocumentSort;
  readonly paging: Paging;
}

function parse(input: DocumentListInput): Result<Parsed, ReadFailure> {
  const fields: { path: string; code: string }[] = [];
  const whole = (value: unknown, min: number, max: number): number | null =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
      ? value
      : null;
  const oneOf = <T extends string>(path: string, value: unknown, list: readonly T[]): T | null => {
    if (value === undefined) return null;
    if (list.includes(value as T)) return value as T;
    fields.push({ path, code: 'value' });
    return null;
  };

  const kind = oneOf('kind', input.kind, DOCUMENT_KINDS) ?? 'order-confirmation';
  let page = 1;
  if (input.page !== undefined) {
    const given = whole(input.page, 1, MAX_PAGED_ROWS);
    if (given === null) fields.push({ path: 'page', code: 'range' });
    else page = given;
  }
  let pageSize = DEFAULT_PAGE_SIZE;
  if (input.pageSize !== undefined) {
    const given = whole(input.pageSize, 1, MAX_PAGE_SIZE);
    if (given === null) fields.push({ path: 'pageSize', code: 'range' });
    else pageSize = given;
  }
  // Previous/Next: asked for by a cursor or a limit; it walks newest first only.
  const prevNext = input.cursor !== undefined || input.limit !== undefined;
  let after: DocumentCursor | null = null;
  let limit = DEFAULT_PAGE_SIZE;
  if (prevNext) {
    for (const path of ['page', 'pageSize', 'sort', 'direction'] as const) {
      if (input[path] !== undefined) fields.push({ path, code: 'with-cursor' });
    }
    if (input.cursor !== undefined) {
      after = decodeCursor(input.cursor);
      if (after === null) fields.push({ path: 'cursor', code: 'format' });
    }
    if (input.limit !== undefined) {
      const given = whole(input.limit, 1, MAX_PAGE_SIZE);
      if (given === null) fields.push({ path: 'limit', code: 'range' });
      else limit = given;
    }
  }
  const key = oneOf('sort', input.sort, DOCUMENT_SORT_KEYS) ?? 'issued';
  const direction = oneOf('direction', input.direction, ['asc', 'desc'] as const) ?? 'desc';

  let reference: string | null = null;
  if (input.q !== undefined) {
    const id = typeof input.q === 'string' ? parseId(input.q.trim().toLowerCase()) : null;
    if (id !== null && id.ok) reference = id.value;
    else fields.push({ path: 'q', code: 'format' });
  }
  let search: string | null = null;
  if (input.search !== undefined) {
    const text = typeof input.search === 'string' ? input.search.trim() : null;
    if (
      text !== null &&
      [...text].length >= MIN_SEARCH_LENGTH &&
      [...text].length <= MAX_SEARCH_LENGTH
    ) {
      search = text;
    } else fields.push({ path: 'search', code: 'length' });
  }
  let sellerId: Id<'Seller'> | null = null;
  if (input.sellerId !== undefined) {
    const parsed = typeof input.sellerId === 'string' ? parseId<'Seller'>(input.sellerId) : null;
    if (parsed !== null && parsed.ok) sellerId = parsed.value;
    else fields.push({ path: 'sellerId', code: 'format' });
  }
  const instant = (path: 'from' | 'to', value: unknown): Temporal.Instant | null => {
    if (value === undefined) return null;
    try {
      if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
        return Temporal.Instant.from(value);
      }
    } catch {
      // falls through to the refusal below
    }
    fields.push({ path, code: 'format' });
    return null;
  };
  const from = instant('from', input.from);
  const to = instant('to', input.to);
  if (from !== null && to !== null && Temporal.Instant.compare(from, to) >= 0) {
    fields.push({ path: 'to', code: 'range' });
  }
  const amount = (path: 'minAmount' | 'maxAmount', value: unknown): bigint | null => {
    if (value === undefined) return null;
    if (typeof value === 'string' && AMOUNT.test(value)) return BigInt(value);
    fields.push({ path, code: 'format' });
    return null;
  };
  const minAmount = amount('minAmount', input.minAmount);
  const maxAmount = amount('maxAmount', input.maxAmount);
  if (minAmount !== null && maxAmount !== null && minAmount > maxAmount) {
    fields.push({ path: 'maxAmount', code: 'range' });
  }
  if (fields.length === 0 && !prevNext && page * pageSize > MAX_PAGED_ROWS) {
    fields.push({ path: 'page', code: 'too-deep' });
  }
  if (fields.length > 0) return err({ code: 'validation.failed', fields });
  return ok({
    filter: { ids: null, kind, reference, sellerId, from, to, minAmount, maxAmount, parties: null },
    search,
    sort: prevNext ? { key: 'issued', direction: 'desc' } : { key, direction },
    paging: prevNext ? { kind: 'prev-next', after, limit } : { kind: 'pages', page, pageSize },
  });
}

/**
 * The Market's documents of one kind for the admin Invoices list: one page with its total and the
 * per-kind counts, then the store and customer names (advisory). The search is resolved by the
 * owning modules before the read unit and fails closed, as on the Orders list.
 */
export async function listDocuments(
  deps: AdminDocumentListDependencies,
  context: CallContext,
  input: DocumentListInput,
  scope: ListScope = {},
): Promise<Result<DocumentListPage, ReadFailure>> {
  const parsed = parse(input ?? {});
  if (!parsed.ok) return parsed;
  const { sort, paging } = parsed.value;
  // An export's selected rows narrow the list's own filter (an AND).
  let filter = { ...parsed.value.filter, ids: scope.ids ?? null };
  let searchCapped = false;
  let searchScope: DocumentListPage['searchScope'] = null;
  if (parsed.value.search !== null) {
    try {
      const [customers, stores] = await Promise.all([
        deps.labels.customerAccountsMatching(context, parsed.value.search),
        deps.labels.sellersMatching(context, parsed.value.search),
      ]);
      filter = {
        ...filter,
        parties: { accountIds: customers.accountIds, sellerIds: stores.sellerIds },
      };
      searchCapped = customers.capped || stores.capped;
      searchScope = customers.searched ? 'customers-and-stores' : 'stores';
    } catch {
      // Never log the text or the error (it may name the term).
      logger.warn({
        msg: 'ordering.admin-document-search.lookup-failed',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      return err({ code: 'ordering.search-unavailable' });
    }
  }
  const read = await deps.unitOfWork.run<
    {
      readonly records: readonly DocumentListRecord[];
      readonly total: number | null;
      readonly nextCursor: string | null;
      readonly counts: DocumentListPage['counts'];
    },
    ReadFailure
  >(
    context.market,
    async () => {
      if (paging.kind === 'prev-next') {
        // One row more than asked tells whether a next page exists.
        const [rows, counts] = await Promise.all([
          deps.documents.page(context.market, filter, sort, 0, paging.limit + 1, paging.after),
          scope.skipCounts === true
            ? Promise.resolve({ orderConfirmations: 0, creditNotes: 0 })
            : deps.documents.countByKind(context.market),
        ]);
        const records = rows.slice(0, paging.limit);
        const last = records[records.length - 1];
        const nextCursor =
          rows.length > paging.limit && last !== undefined
            ? encodeDocumentCursor({ issuedAt: last.issuedAt, documentId: last.documentId })
            : null;
        return ok({ records, total: null, nextCursor, counts });
      }
      const { page, pageSize } = paging;
      const [records, counts] = await Promise.all([
        deps.documents.page(context.market, filter, sort, (page - 1) * pageSize, pageSize),
        deps.documents.countByKind(context.market),
      ]);
      // A tab with no other filter has its count already; only a narrower filter counts again.
      const total =
        tabTotal(filter, counts) ?? (await deps.documents.count(context.market, filter));
      return ok({ records, total, nextCursor: null, counts });
    },
    { readOnly: true },
  );
  if (!read.ok) return read;
  const { records } = read.value;
  const [storeAnswer, customerAnswer] =
    records.length === 0
      ? [undefined, undefined]
      : await Promise.allSettled([
          deps.labels.storeNamesOf(context, [...new Set(records.map((r) => r.sellerId))]),
          deps.labels.customersOf(context, [...new Set(records.map((r) => r.accountId))]),
        ]);
  const storeNames =
    storeAnswer === undefined ? undefined : settled(context, 'store-names', storeAnswer);
  const customers =
    customerAnswer === undefined ? undefined : settled(context, 'customers', customerAnswer);
  return ok({
    rows: records.map((record) => ({
      ...record,
      documentNumber: null,
      storeName: storeNames?.get(record.sellerId) ?? null,
      customer: customers?.get(record.accountId) ?? null,
      actions: documentRowActions(record),
    })),
    counts: read.value.counts,
    total: read.value.total,
    page: paging.kind === 'pages' ? paging.page : null,
    pageSize: paging.kind === 'pages' ? paging.pageSize : paging.limit,
    nextCursor: read.value.nextCursor,
    searchCapped,
    searchScope,
  });
}

/** The total of a filter that is only a tab (a kind), read from the tab counts; else null. */
export function tabTotal(
  filter: DocumentListFilter,
  counts: DocumentListPage['counts'],
): number | null {
  const { kind, ...rest } = filter;
  if (Object.values(rest).some((value) => value !== null)) return null;
  return kind === 'credit-note' ? counts.creditNotes : counts.orderConfirmations;
}
