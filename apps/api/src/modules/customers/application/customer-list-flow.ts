import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import {
  CUSTOMER_DEFAULT_PAGE_SIZE,
  CUSTOMER_FILTER_KEYS,
  CUSTOMER_MAX_PAGE_SIZE,
  CUSTOMER_MAX_PAGED_ROWS,
  parseCustomerSelector,
  parseSort,
  type CustomerListRow,
  type CustomerSelector,
  type CustomerSort,
  type CustomerView,
  type SortDirection,
} from '../domain/customer-list';
import type { CustomerListQuery, CustomerListReader } from './ports/customer-list.reader';

// The reading of a list request and the page it answers. Plain functions: use cases cannot extend
// one another.

export type ListValidationFailure = {
  readonly code: 'validation.failed';
  readonly fields: readonly { readonly path: string; readonly code: string }[];
};

export const invalidField = (
  path: string,
  code: string,
): { readonly ok: false; readonly error: ListValidationFailure } => ({
  ok: false,
  error: { code: 'validation.failed', fields: [{ path, code }] },
});

export interface CustomerListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly listReader: CustomerListReader;
  readonly clock: Clock;
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The admin the call acts for. The population is checked here, the key by the gate. */
export function adminAccountOf(context: CallContext): Id<'Account'> | null {
  const { actor } = context;
  return actor.kind === 'authenticated' && actor.population === 'admin' ? actor.accountId : null;
}

const LIST_KEYS = new Set([
  'view',
  'q',
  'filters',
  'sort',
  'direction',
  'page',
  'pageSize',
  'cursor',
  'limit',
]);

/** The selector keys of a request without paging: used by the ids read and the export. */
export const SELECTOR_REQUEST_KEYS = ['view', 'q', 'filters'] as const;

/** Reads the tab, search and filters of a request body. */
export function selectorOfRequest(
  input: Record<string, unknown>,
): Result<CustomerSelector, ListValidationFailure> {
  const filters = input['filters'];
  if (filters !== undefined && filters !== null) {
    if (!isRecord(filters)) return invalidField('filters', 'type');
    for (const key of Object.keys(filters)) {
      if (!(CUSTOMER_FILTER_KEYS as readonly string[]).includes(key)) {
        return invalidField(`filters.${key}`, 'unknown');
      }
    }
  }
  const parsed = parseCustomerSelector(
    {
      view: input['view'],
      q: input['q'],
      ...(isRecord(filters) ? { filters } : {}),
    },
    '',
    'filters.',
  );
  return parsed.ok ? ok(parsed.value) : invalidField(parsed.error.path, parsed.error.code);
}

export interface ListPageRequest {
  readonly selector: CustomerSelector;
  readonly sort: CustomerSort;
  readonly direction: SortDirection;
  /** Page-number mode when set; otherwise the cursor mode. */
  readonly page: number | null;
  readonly offset: number;
  readonly limit: number;
}

const CURSOR = /^o(\d{1,5})$/;

export function parseListRequest(input: unknown): Result<ListPageRequest, ListValidationFailure> {
  if (!isRecord(input)) return invalidField('body', 'type');
  for (const key of Object.keys(input)) {
    if (!LIST_KEYS.has(key)) return invalidField(key, 'unknown');
  }
  const selector = selectorOfRequest(input);
  if (!selector.ok) return selector;
  const order = parseSort(input['sort'], input['direction']);
  if (!order.ok) return invalidField(order.error.path, order.error.code);

  const wholeNumber = (value: unknown, min: number, max: number): number | null =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
      ? value
      : null;

  if (input['page'] !== undefined) {
    if (input['cursor'] !== undefined) return invalidField('cursor', 'conflict');
    const page = wholeNumber(input['page'], 1, 1_000_000);
    if (page === null) return invalidField('page', 'range');
    const size =
      input['pageSize'] === undefined
        ? CUSTOMER_DEFAULT_PAGE_SIZE
        : wholeNumber(input['pageSize'], 1, CUSTOMER_MAX_PAGE_SIZE);
    if (size === null) return invalidField('pageSize', 'range');
    if ((page - 1) * size >= CUSTOMER_MAX_PAGED_ROWS) return invalidField('page', 'range');
    return ok({
      selector: selector.value,
      ...order.value,
      page,
      offset: (page - 1) * size,
      limit: size,
    });
  }

  if (input['pageSize'] !== undefined) return invalidField('pageSize', 'needs-page');
  const limit =
    input['limit'] === undefined
      ? CUSTOMER_DEFAULT_PAGE_SIZE
      : wholeNumber(input['limit'], 1, CUSTOMER_MAX_PAGE_SIZE);
  if (limit === null) return invalidField('limit', 'range');
  let offset = 0;
  if (input['cursor'] !== undefined) {
    const match = typeof input['cursor'] === 'string' ? CURSOR.exec(input['cursor']) : null;
    if (match === null) return invalidField('cursor', 'format');
    offset = Number(match[1]);
  }
  return ok({ selector: selector.value, ...order.value, page: null, offset, limit });
}

export interface CustomerRowView {
  readonly accountId: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly status: 'active' | 'disabled';
  readonly emailVerified: boolean;
  readonly signedUpAt: string;
  readonly lastOrderAt: string | null;
  readonly orderCount: number;
  /** Minor units of `currency`, as digits (it can pass 2^53). */
  readonly spentMinor: string;
  readonly currency: string | null;
  readonly refundCount: number;
}

export const rowView = (row: CustomerListRow): CustomerRowView => ({
  accountId: row.accountId,
  email: row.email,
  displayName: row.displayName,
  status: row.status,
  emailVerified: row.emailVerified,
  signedUpAt: row.signedUpAt.toString(),
  lastOrderAt: row.lastOrderAt === null ? null : row.lastOrderAt.toString(),
  orderCount: row.orderCount,
  spentMinor: row.spentMinor.toString(),
  currency: row.currency,
  refundCount: row.refundCount,
});

export interface CustomerListOutput {
  readonly items: readonly CustomerRowView[];
  /** The size of every tab (all customers, ignoring the search and filters). */
  readonly counts: Readonly<Record<CustomerView, number>>;
  /** Page-number mode only: the customers the search and filters match, and where the page is. */
  readonly paging: {
    readonly total: number;
    readonly page: number;
    readonly pageSize: number;
    /** Page numbers stop at this row. */
    readonly maxRows: number;
  } | null;
  /** Cursor mode only: the cursor of the next page, or null on the last page. */
  readonly nextCursor: string | null;
}

export async function listCustomers(
  deps: CustomerListDependencies,
  context: CallContext,
  request: ListPageRequest,
): Promise<Result<CustomerListOutput, { readonly code: 'access.unavailable' }>> {
  const query: CustomerListQuery = { selector: request.selector, now: deps.clock.now() };
  const read = await deps.unitOfWork.run<
    {
      readonly rows: readonly CustomerListRow[];
      readonly counts: Readonly<Record<CustomerView, number>>;
      readonly total: number | null;
      readonly more: boolean;
    },
    never
  >(
    context.market,
    async () => {
      const { market } = context;
      const order = { sort: request.sort, direction: request.direction };
      if (request.page !== null) {
        const [rows, counts, total] = await Promise.all([
          deps.listReader.rows(market, query, order, {
            offset: request.offset,
            limit: request.limit,
          }),
          deps.listReader.viewCounts(market, query.now),
          deps.listReader.count(market, query),
        ]);
        return ok({ rows, counts, total, more: false });
      }
      const [rows, counts] = await Promise.all([
        deps.listReader.rows(market, query, order, {
          offset: request.offset,
          limit: request.limit + 1,
        }),
        deps.listReader.viewCounts(market, query.now),
      ]);
      return ok({
        rows: rows.slice(0, request.limit),
        counts,
        total: null,
        more: rows.length > request.limit,
      });
    },
    { readOnly: true },
  );
  if (!read.ok) return err({ code: 'access.unavailable' });
  const { rows, counts, total, more } = read.value;
  const nextOffset = request.offset + request.limit;
  return ok({
    items: rows.map(rowView),
    counts,
    paging:
      request.page === null || total === null
        ? null
        : {
            total,
            page: request.page,
            pageSize: request.limit,
            maxRows: CUSTOMER_MAX_PAGED_ROWS,
          },
    nextCursor:
      request.page === null && more && nextOffset < CUSTOMER_MAX_PAGED_ROWS
        ? `o${nextOffset}`
        : null,
  });
}
