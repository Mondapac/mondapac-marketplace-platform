import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { EventDelivery } from '../../../platform/events/event-delivery';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import { CUSTOMER_MAX_PAGED_ROWS } from '../domain/customer-list';
import {
  CUSTOMER_CODE_PATTERN,
  codePrefixOf,
  normalizeCodeTerm,
  parseSellerCustomerSelector,
  SELLER_CUSTOMER_DEFAULT_PAGE_SIZE,
  SELLER_CUSTOMER_MAX_PAGE_SIZE,
  SELLER_CUSTOMER_SORTS,
  sellerCustomerEntriesOf,
  type SellerCustomerRecord,
  type SellerCustomerSelector,
  type SellerCustomerSort,
  type SellerCustomerTab,
  type SellerCustomerView,
} from '../domain/seller-customers';
import type { ReadModelFailure } from './customer-read-model-flow';
import type { CustomerReadModelRepository } from './ports/customer-read-models.repository';
import type { CustomerReadModelPeers } from './ports/customer-read-model-peers';
import type {
  CustomerCodes,
  MonthlyCount,
  SellerCustomerRepository,
  TrendZones,
} from './ports/seller-customers.repository';
import type { SheetWriter } from './ports/sheet-writer';

// The per-seller customers read model (customers management phase 3): its sync from `ordering`
// and `engagement`, the nightly reconcile, and the reads of the seller's Customers list and the
// admin's Customers tab of a seller. Plain functions: use cases cannot extend one another.

export interface SellerCustomerDependencies extends CustomerReadModelPeers {
  readonly unitOfWork: UnitOfWork;
  readonly sellerCustomers: SellerCustomerRepository;
  readonly codes: CustomerCodes;
  readonly readModels: CustomerReadModelRepository;
  readonly clock: Clock;
  readonly audit: AuditWriter;
  readonly sheetWriter: SheetWriter;
  readonly zones: TrendZones;
}

/** Codes drawn for one new row before the sync gives up (40 random bits: never reached). */
const CODE_ATTEMPTS = 8;
/** Accounts read per page of the reconcile walk. */
const RECONCILE_PAGE = 100;
/** The most pages one reconcile run walks (40,000 customers); the events keep the rest. */
const RECONCILE_MAX_PAGES = 400;

// ---------------------------------------------------------------------------------------------
// Sync

/**
 * Brings one customer's per-seller rows in line with `ordering` (their confirmed orders per
 * seller, refunds taken off) and `engagement` (the stores they follow), both read before the unit.
 * The write replaces, never increments, so a repeated or late event changes nothing. A row keeps
 * its code once drawn; a seller with no relation left loses the row (and with it the code). An
 * account with no directory row (never copied, or erased) has no rows: the foreign key to the
 * directory also refuses one, and the directory's deletion cascades to them.
 */
export async function syncSellerCustomers(
  deps: SellerCustomerDependencies,
  context: CallContext,
  accountId: Id<'Account'>,
  delivery: EventDelivery | null,
): Promise<Result<{ readonly rows: number }, ReadModelFailure>> {
  const totals = await deps.ordering.customerSellerStats(context, accountId);
  if (!totals.ok) return err({ code: 'customers.unavailable' });
  const follows = await deps.engagement.followsOfAccount(context, accountId);
  if (!follows.ok) return err({ code: 'customers.unavailable' });
  const entries = sellerCustomerEntriesOf(accountId, totals.value, follows.value);

  const work = async (): Promise<Result<{ readonly rows: number }, ReadModelFailure>> => {
    const { market } = context;
    const existing = await deps.sellerCustomers.codesOfAccount(market, accountId);
    const keep = (await deps.readModels.hasDirectory(market, accountId)) ? entries : [];
    const now = deps.clock.now();
    for (const entry of keep) {
      let code = existing.get(entry.sellerId) ?? null;
      for (let attempt = 0; code === null && attempt < CODE_ATTEMPTS; attempt += 1) {
        const drawn = deps.codes.next();
        if (!(await deps.sellerCustomers.codeTaken(market, entry.sellerId, drawn))) code = drawn;
      }
      if (code === null) throw new Error('customers.seller-customers: no free customer code');
      await deps.sellerCustomers.upsert(market, entry, code, now);
    }
    const kept = new Set<string>(keep.map((entry) => entry.sellerId));
    await deps.sellerCustomers.removeSellers(
      market,
      accountId,
      [...existing.keys()].filter((sellerId) => !kept.has(sellerId)),
    );
    return ok({ rows: keep.length });
  };
  if (delivery === null) return deps.unitOfWork.run(context.market, work);
  const handled = await deps.unitOfWork.runOnce(context.market, delivery, work);
  return handled.ok ? ok(handled.value.handled ? handled.value.value : { rows: 0 }) : handled;
}

/** Records a delivery that names nothing to refresh as handled (an order or refund that is gone). */
export async function markHandled(
  deps: SellerCustomerDependencies,
  context: CallContext,
  delivery: EventDelivery,
): Promise<Result<{ readonly rows: number }, ReadModelFailure>> {
  const handled = await deps.unitOfWork.runOnce<{ readonly rows: number }, ReadModelFailure>(
    context.market,
    delivery,
    () => Promise.resolve(ok({ rows: 0 })),
  );
  return handled.ok ? ok({ rows: 0 }) : handled;
}

export interface SellerCustomerReconcileCounts {
  readonly accounts: number;
  readonly rows: number;
  /** Accounts whose sync failed; the run goes on past them and the next run tries again. */
  readonly failed: number;
  /** True when the run stopped at its page limit with customers left (the job logs a warning). */
  readonly capped: boolean;
}

/**
 * The backfill and the nightly reconcile: every customer with a directory row is synced again
 * (a keyset walk over the directory). Safe to run twice and concurrently: every write replaces.
 */
export async function reconcileSellerCustomers(
  deps: SellerCustomerDependencies,
  context: CallContext,
): Promise<Result<SellerCustomerReconcileCounts, ReadModelFailure>> {
  let accounts = 0;
  let rows = 0;
  let failed = 0;
  let capped = true;
  let after: Id<'Account'> | null = null;
  for (let page = 0; page < RECONCILE_MAX_PAGES; page += 1) {
    const ids = await deps.unitOfWork.run<readonly Id<'Account'>[], ReadModelFailure>(
      context.market,
      async () => ok(await deps.readModels.directoryIds(context.market, after, RECONCILE_PAGE)),
      { readOnly: true },
    );
    if (!ids.ok) return ids;
    for (const accountId of ids.value) {
      // One failing account (a peer outage, a lost code race) never stops the others.
      const synced = await syncSellerCustomers(deps, context, accountId, null).catch(() => null);
      if (synced === null || !synced.ok) {
        failed += 1;
        continue;
      }
      accounts += 1;
      rows += synced.value.rows;
    }
    if (ids.value.length < RECONCILE_PAGE) {
      capped = false;
      break;
    }
    after = ids.value[ids.value.length - 1]!;
  }
  return ok({ accounts, rows, failed, capped });
}

// ---------------------------------------------------------------------------------------------
// The callers

export type SellerCustomersValidationFailure = {
  readonly code: 'validation.failed';
  readonly fields: readonly { readonly path: string; readonly code: string }[];
};

export const invalid = (
  path: string,
  code: string,
): { readonly ok: false; readonly error: SellerCustomersValidationFailure } => ({
  ok: false,
  error: { code: 'validation.failed', fields: [{ path, code }] },
});

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasActingAs = (actor: object): boolean => {
  if (!Object.hasOwn(actor, 'actingAs')) return false;
  const marker = (actor as { readonly actingAs?: unknown }).actingAs;
  return marker !== null && marker !== undefined;
};

/**
 * The seller whose customers a call reads: the session's own shop, never an input. A Login as
 * Seller session reads no customers (the marker is reserved on the actor), as the order customer
 * names refuse it.
 */
export function sellerOfCall(context: CallContext): Id<'Seller'> | null {
  const { actor } = context;
  if (actor.kind !== 'authenticated' || actor.population !== 'seller') return null;
  if (hasActingAs(actor)) return null;
  const seller = typeof actor.sellerId === 'string' ? parseId<'Seller'>(actor.sellerId) : null;
  return seller !== null && seller.ok ? seller.value : null;
}

/** The admin a call acts for; a Login as Seller session is refused. */
export function adminOfCall(context: CallContext): Id<'Account'> | null {
  const { actor } = context;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin') return null;
  if (hasActingAs(actor)) return null;
  return actor.accountId;
}

// ---------------------------------------------------------------------------------------------
// The list

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
export const SELECTOR_KEYS = ['view', 'q', 'filters'] as const;
const CURSOR = /^o(\d{1,5})$/;

export interface SellerCustomerPageRequest {
  readonly selector: SellerCustomerSelector;
  readonly sort: SellerCustomerSort;
  readonly direction: 'asc' | 'desc';
  /** Page-number mode when set; otherwise the cursor mode. */
  readonly page: number | null;
  readonly offset: number;
  readonly limit: number;
}

/** The tab, search and filters of a body. */
export function selectorOf(
  input: Record<string, unknown>,
): Result<SellerCustomerSelector, SellerCustomersValidationFailure> {
  const parsed = parseSellerCustomerSelector({
    view: input['view'],
    q: input['q'],
    filters: input['filters'],
  });
  return parsed.ok ? parsed : invalid(parsed.error.path, parsed.error.code);
}

const wholeNumber = (value: unknown, min: number, max: number): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : null;

/** Reads a list body: the selector, the sort, and a page number or a cursor (as the admin list). */
export function parseSellerCustomerPage(
  input: unknown,
): Result<SellerCustomerPageRequest, SellerCustomersValidationFailure> {
  if (!isRecord(input)) return invalid('body', 'type');
  for (const key of Object.keys(input)) if (!LIST_KEYS.has(key)) return invalid(key, 'unknown');
  const selector = selectorOf(input);
  if (!selector.ok) return selector;

  let sort: SellerCustomerSort = 'last-order';
  if (input['sort'] !== undefined) {
    const found = SELLER_CUSTOMER_SORTS.find((candidate) => candidate === input['sort']);
    if (found === undefined) return invalid('sort', 'value');
    sort = found;
  }
  let direction: 'asc' | 'desc' = sort === 'code' ? 'asc' : 'desc';
  if (input['direction'] !== undefined) {
    if (input['direction'] !== 'asc' && input['direction'] !== 'desc') {
      return invalid('direction', 'value');
    }
    direction = input['direction'];
  }

  if (input['page'] !== undefined) {
    if (input['cursor'] !== undefined) return invalid('cursor', 'conflict');
    const page = wholeNumber(input['page'], 1, 1_000_000);
    if (page === null) return invalid('page', 'range');
    const size =
      input['pageSize'] === undefined
        ? SELLER_CUSTOMER_DEFAULT_PAGE_SIZE
        : wholeNumber(input['pageSize'], 1, SELLER_CUSTOMER_MAX_PAGE_SIZE);
    if (size === null) return invalid('pageSize', 'range');
    if ((page - 1) * size >= CUSTOMER_MAX_PAGED_ROWS) return invalid('page', 'range');
    return ok({
      selector: selector.value,
      sort,
      direction,
      page,
      offset: (page - 1) * size,
      limit: size,
    });
  }
  if (input['pageSize'] !== undefined) return invalid('pageSize', 'needs-page');
  const limit =
    input['limit'] === undefined
      ? SELLER_CUSTOMER_DEFAULT_PAGE_SIZE
      : wholeNumber(input['limit'], 1, SELLER_CUSTOMER_MAX_PAGE_SIZE);
  if (limit === null) return invalid('limit', 'range');
  let offset = 0;
  if (input['cursor'] !== undefined) {
    const match = typeof input['cursor'] === 'string' ? CURSOR.exec(input['cursor']) : null;
    if (match === null) return invalid('cursor', 'format');
    offset = Number(match[1]);
    if (offset >= CUSTOMER_MAX_PAGED_ROWS) return invalid('cursor', 'range');
  }
  return ok({ selector: selector.value, sort, direction, page: null, offset, limit });
}

/** A row of the seller's list as answered: no account id, email or full name. */
export interface SellerCustomerRowView {
  readonly code: string;
  readonly firstName: string | null;
  readonly orderCount: number;
  readonly firstOrderAt: string | null;
  readonly lastOrderAt: string | null;
  /** Minor units as digits, or null when the customer never bought from the shop. */
  readonly spentMinor: string | null;
  readonly currency: string | null;
  readonly follower: boolean;
  readonly followedAt: string | null;
  readonly exclusive: boolean;
  readonly since: string;
}

/** An admin's row: the seller's row plus the account, for the link to the customer's page. */
export interface AdminSellerCustomerRowView extends SellerCustomerRowView {
  readonly accountId: string;
}

const instantText = (instant: Temporal.Instant | null): string | null =>
  instant === null ? null : instant.toString();

export function sellerRowView(row: SellerCustomerView): SellerCustomerRowView {
  return {
    code: row.code,
    firstName: row.firstName,
    orderCount: row.orderCount,
    firstOrderAt: instantText(row.firstOrderAt),
    lastOrderAt: instantText(row.lastOrderAt),
    spentMinor: row.spent === null ? null : row.spent.amount.toString(),
    currency: row.spent === null ? null : row.spent.currency,
    follower: row.follower,
    followedAt: instantText(row.followedAt),
    exclusive: row.exclusive,
    since: row.since.toString(),
  };
}

/**
 * Built field by field from the record, so no field the seller's row leaves out (the account) is
 * carried into the seller's answer by a spread.
 */
export function sellerRowOfRecord(record: SellerCustomerRecord): SellerCustomerRowView {
  return sellerRowView({
    code: record.code,
    firstName: record.firstName,
    orderCount: record.orderCount,
    firstOrderAt: record.firstOrderAt,
    lastOrderAt: record.lastOrderAt,
    spent: record.spent,
    follower: record.follower,
    followedAt: record.followedAt,
    exclusive: record.exclusive,
    since: record.since,
  });
}

export function adminRowView(record: SellerCustomerRecord): AdminSellerCustomerRowView {
  return { ...sellerRowOfRecord(record), accountId: record.accountId };
}

export interface SellerCustomerListOutput<Row> {
  readonly items: readonly Row[];
  /** The size of every tab (ignoring the search and filters). */
  readonly counts: Readonly<Record<SellerCustomerTab, number>>;
  readonly paging: {
    readonly total: number;
    readonly page: number;
    readonly pageSize: number;
    readonly maxRows: number;
  } | null;
  readonly nextCursor: string | null;
}

/** One page of one seller's customers, its tab sizes and (page-number mode) the total. */
export async function listSellerCustomers<Row>(
  deps: SellerCustomerDependencies,
  context: CallContext,
  sellerId: Id<'Seller'>,
  request: SellerCustomerPageRequest,
  view: (record: SellerCustomerRecord) => Row,
): Promise<Result<SellerCustomerListOutput<Row>, { readonly code: 'access.unavailable' }>> {
  const { market } = context;
  const query = { sellerId, selector: request.selector };
  const order = { sort: request.sort, direction: request.direction };
  const paged = request.page !== null;
  const read = await deps.unitOfWork.run(
    market,
    async () => {
      const [rows, counts, total] = await Promise.all([
        deps.sellerCustomers.page(market, query, order, {
          offset: request.offset,
          limit: paged ? request.limit : request.limit + 1,
        }),
        deps.sellerCustomers.tabCounts(market, sellerId),
        paged ? deps.sellerCustomers.count(market, query) : Promise.resolve(null),
      ]);
      return ok({ rows, counts, total });
    },
    { readOnly: true },
  );
  if (!read.ok) return err({ code: 'access.unavailable' });
  const { rows, counts, total } = read.value;
  const more = !paged && rows.length > request.limit;
  const nextOffset = request.offset + request.limit;
  return ok({
    items: rows.slice(0, request.limit).map(view),
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
    nextCursor: more && nextOffset < CUSTOMER_MAX_PAGED_ROWS ? `o${nextOffset}` : null,
  });
}

/** A whole customer code as a seller typed it, in the stored form; null when it is not one. */
export function customerCodeOf(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 20) return null;
  const symbols = normalizeCodeTerm(raw);
  if (symbols === null || symbols.length !== 8) return null;
  const code = codePrefixOf(symbols);
  return CUSTOMER_CODE_PATTERN.test(code) ? code : null;
}

// ---------------------------------------------------------------------------------------------
// The admin's monthly trend

export const TREND_MONTHS = 12;

/** The last `count` months of the zone, oldest first, each as `YYYY-MM` and its two instants. */
export function trendMonths(
  now: Temporal.Instant,
  zone: string,
  count = TREND_MONTHS,
): { readonly month: string; readonly from: Temporal.Instant; readonly to: Temporal.Instant }[] {
  const today = now.toZonedDateTimeISO(zone).toPlainDate();
  const first = Temporal.PlainYearMonth.from({ year: today.year, month: today.month });
  const months = [];
  for (let back = count - 1; back >= 0; back -= 1) {
    const month = first.subtract({ months: back });
    const start = month.toPlainDate({ day: 1 });
    const next = month.add({ months: 1 }).toPlainDate({ day: 1 });
    months.push({
      month: month.toString(),
      from: start.toZonedDateTime({ timeZone: zone }).toInstant(),
      to: next.toZonedDateTime({ timeZone: zone }).toInstant(),
    });
  }
  return months;
}

export interface SellerCustomerSummary {
  readonly counts: Readonly<Record<SellerCustomerTab, number>>;
  readonly zone: string;
  readonly months: readonly MonthlyCount[];
}

export async function sellerCustomerSummary(
  deps: SellerCustomerDependencies,
  context: CallContext,
  sellerId: Id<'Seller'>,
): Promise<Result<SellerCustomerSummary, { readonly code: 'access.unavailable' }>> {
  const zone = deps.zones.zoneOf(context.market);
  const months = trendMonths(deps.clock.now(), zone);
  const read = await deps.unitOfWork.run(
    context.market,
    async () => {
      const [counts, monthly] = await Promise.all([
        deps.sellerCustomers.tabCounts(context.market, sellerId),
        deps.sellerCustomers.monthly(context.market, sellerId, months),
      ]);
      return ok({ counts, zone, months: monthly });
    },
    { readOnly: true },
  );
  return read.ok ? read : err({ code: 'access.unavailable' });
}
