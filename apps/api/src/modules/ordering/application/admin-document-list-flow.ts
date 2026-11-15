import { Logger } from '@nestjs/common';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import {
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

interface Parsed {
  readonly filter: DocumentListFilter;
  readonly search: string | null;
  readonly sort: DocumentSort;
  readonly page: number;
  readonly pageSize: number;
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
  if (fields.length === 0 && page * pageSize > MAX_PAGED_ROWS) {
    fields.push({ path: 'page', code: 'too-deep' });
  }
  if (fields.length > 0) return err({ code: 'validation.failed', fields });
  return ok({
    filter: { kind, reference, sellerId, from, to, minAmount, maxAmount, parties: null },
    search,
    sort: { key, direction },
    page,
    pageSize,
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
): Promise<Result<DocumentListPage, ReadFailure>> {
  const parsed = parse(input ?? {});
  if (!parsed.ok) return parsed;
  const { sort, page, pageSize } = parsed.value;
  let filter = parsed.value.filter;
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
      readonly total: number;
      readonly counts: DocumentListPage['counts'];
    },
    ReadFailure
  >(
    context.market,
    async () => {
      const [records, total, counts] = await Promise.all([
        deps.documents.page(context.market, filter, sort, (page - 1) * pageSize, pageSize),
        deps.documents.count(context.market, filter),
        deps.documents.countByKind(context.market),
      ]);
      return ok({ records, total, counts });
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
    page,
    pageSize,
    searchCapped,
    searchScope,
  });
}
