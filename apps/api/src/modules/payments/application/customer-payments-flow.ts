import { err, ok, parseId } from '@mondapac/shared-kernel';
import type {
  AuditEntry,
  CallContext,
  Clock,
  Id,
  Money,
  Result,
  Temporal,
} from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { ConsumedStepUp, PermissionKey, StepUpProofConsumer } from '../../../platform/authz';
import {
  buildExportFile,
  checkExportSize,
  LIST_EXPORT_MAX_ROWS,
  parseExportFormat,
  type ExportCell,
  type ExportFile,
  type ExportFormat,
  type ExportTooLarge,
  type SheetWriter,
} from '../../../platform/list-export';
import {
  listPage,
  MAX_PAGED_ROWS,
  pageWindow,
  parseClosedValues,
  parseInstantRange,
  parseListQuery,
  type ListPage,
  type ListQueryFailure,
} from '../../../platform/list-query';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { OrderingFacade } from '../../ordering';
import { CustomerDisputesExported, CustomerPaymentsExported } from '../domain/audit';
import {
  DISPUTE_STATUSES,
  type DisputeOutcome,
  type DisputeReason,
  type DisputeStatus,
} from '../domain/dispute';
import type { DisputeRecord, DisputeStore, OrdersDisputeQuery } from './ports/dispute-store';

// One customer's payments and disputes as super lists for the customer page (customers management
// phase 2b, gaps c, d and f). A payments path: provider data is kept to the payment id the
// handoff asks for (Stripe's PaymentIntent id on a payment); a dispute carries no provider id at
// all. The payment facts live on ordering's orders, so the payments list asks ordering through its
// facade (declaring this module's key); disputes are payments' own rows, found by the customer's
// order ids. Filters take ISO instants: the panel works the admin's local days out (ADR-0005).

/** The customers export key and its step-up action (declared by customers; pinned by a contract test). */
export const CUSTOMER_DATA_EXPORT_KEY = 'customers.customers.export' as PermissionKey;
export const CUSTOMER_DATA_EXPORT_STEP_UP = 'customers.customers.export';

export const PAYMENT_STATES = ['none', 'authorised', 'captured', 'voided'] as const;
export const ORDER_STATUSES = ['pending-payment', 'confirmed', 'cancelled'] as const;
/** The most orders of one customer whose disputes are looked for (more is refused whole). */
export const DISPUTE_ORDER_SCAN = 10_000;

export interface CustomerPaymentsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly ordering: Pick<OrderingFacade, 'adminCustomerPayments' | 'adminCustomerOrderIds'>;
  readonly disputes: DisputeStore;
  readonly audit: AuditWriter;
  readonly stepUp: StepUpProofConsumer;
  readonly sheetWriter: SheetWriter;
  readonly clock: Clock;
}

export type CustomerPaymentsFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'second-factor.required'; readonly actionKey?: string }
  | { readonly code: 'second-factor.enrolment-required'; readonly actionKey?: string }
  | ExportTooLarge
  | ListQueryFailure;

/** One payment as the customer page shows it. */
export interface CustomerPaymentView {
  readonly orderId: string;
  readonly status: string;
  readonly paymentState: string;
  readonly amount: Money;
  /** Stripe's PaymentIntent id (pi_...), for the Stripe Dashboard; null before one exists. */
  readonly providerPaymentId: string | null;
  readonly createdAt: string;
  readonly confirmedAt: string | null;
}

/** The payments page plus what the customer paid (captured orders), one sum per currency. */
export interface CustomerPaymentsListPage extends ListPage<CustomerPaymentView> {
  readonly paid: readonly Money[];
}

/** One dispute as the customer page shows it: no provider id, no evidence, no buyer text. */
export interface CustomerDisputeView {
  readonly disputeId: string;
  readonly orderId: string;
  readonly status: DisputeStatus;
  readonly reason: DisputeReason;
  readonly amount: Money;
  readonly openedAt: string;
  readonly evidenceDueBy: string | null;
  readonly outcome: DisputeOutcome | null;
}

const PAYMENT_SPEC = {
  sorts: ['created', 'amount'] as const,
  defaultSort: 'created' as const,
  defaultPageSize: 25,
  maxPageSize: 100,
  maxPage: Math.ceil(MAX_PAGED_ROWS / 25),
};

const DISPUTE_SPEC = {
  sorts: ['opened', 'amount', 'due'] as const,
  defaultSort: 'opened' as const,
  defaultPageSize: 25,
  maxPageSize: 100,
  maxPage: Math.ceil(MAX_PAGED_ROWS / 25),
};

const LIST_KEYS = ['accountId', 'filters', 'sort', 'direction', 'page', 'pageSize', 'paging'];
const EXPORT_KEYS = ['accountId', 'filters', 'format', 'sort', 'direction'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const invalid = (path: string, code: string): { ok: false; error: ListQueryFailure } => ({
  ok: false,
  error: { code: 'validation.failed', fields: [{ path, code }] },
});

function isAdmin(context: CallContext): boolean {
  const { actor } = context;
  return (
    actor.kind === 'authenticated' &&
    actor.population === 'admin' &&
    !(Object.hasOwn(actor, 'actingAs') && (actor as { actingAs?: unknown }).actingAs != null)
  );
}

function closed(
  input: unknown,
  keys: readonly string[],
): Result<Record<string, unknown>, ListQueryFailure> {
  if (!isRecord(input)) return invalid('body', 'type');
  for (const key of Object.keys(input)) if (!keys.includes(key)) return invalid(key, 'unknown');
  return ok(input);
}

function accountOf(input: Record<string, unknown>): Result<Id<'Account'>, ListQueryFailure> {
  const parsed =
    typeof input['accountId'] === 'string' ? parseId<'Account'>(input['accountId']) : null;
  return parsed === null || !parsed.ok ? invalid('accountId', 'format') : ok(parsed.value);
}

function filtersOf(
  input: Record<string, unknown>,
  keys: readonly string[],
): Result<Record<string, unknown>, ListQueryFailure> {
  const raw = input['filters'] ?? {};
  if (!isRecord(raw)) return invalid('filters', 'type');
  for (const key of Object.keys(raw))
    if (!keys.includes(key)) return invalid(`filters.${key}`, 'unknown');
  return ok(raw);
}

/** ordering's refusal as this module answers it: a denial stays a denial, anything else unavailable. */
const fromOrdering = (code: string): CustomerPaymentsFailure =>
  code === 'access.denied' ? { code: 'access.denied' } : { code: 'access.unavailable' };

// ---- payments -------------------------------------------------------------------------------

interface PaymentsRequest {
  readonly accountId: Id<'Account'>;
  readonly query: {
    readonly accountId: Id<'Account'>;
    readonly paymentStates: readonly (typeof PAYMENT_STATES)[number][] | null;
    readonly statuses: readonly (typeof ORDER_STATUSES)[number][] | null;
    readonly from: Temporal.Instant | null;
    readonly to: Temporal.Instant | null;
  };
}

function paymentsRequestOf(
  input: Record<string, unknown>,
): Result<PaymentsRequest, ListQueryFailure> {
  const accountId = accountOf(input);
  if (!accountId.ok) return accountId;
  const raw = filtersOf(input, ['paymentState', 'status', 'from', 'to']);
  if (!raw.ok) return raw;
  const paymentStates = parseClosedValues(
    raw.value['paymentState'],
    PAYMENT_STATES,
    'filters.paymentState',
  );
  if (!paymentStates.ok) return paymentStates;
  const statuses = parseClosedValues(raw.value['status'], ORDER_STATUSES, 'filters.status');
  if (!statuses.ok) return statuses;
  const range = parseInstantRange(raw.value);
  if (!range.ok) return range;
  return ok({
    accountId: accountId.value,
    query: {
      accountId: accountId.value,
      paymentStates: paymentStates.value,
      statuses: statuses.value,
      ...range.value,
    },
  });
}

const paymentView = (row: {
  readonly orderId: string;
  readonly status: string;
  readonly paymentState: string;
  readonly amount: Money;
  readonly providerPaymentId: string | null;
  readonly createdAt: { toString(): string };
  readonly confirmedAt: { toString(): string } | null;
}): CustomerPaymentView => ({
  orderId: row.orderId,
  status: row.status,
  paymentState: row.paymentState,
  amount: row.amount,
  providerPaymentId: row.providerPaymentId,
  createdAt: row.createdAt.toString(),
  confirmedAt: row.confirmedAt === null ? null : row.confirmedAt.toString(),
});

/** One page of a customer's payments (orders as payments) with the captured total ("Paid"). */
export async function readCustomerPayments(
  deps: CustomerPaymentsDependencies,
  context: CallContext,
  input: unknown,
): Promise<Result<CustomerPaymentsListPage, CustomerPaymentsFailure>> {
  if (!isAdmin(context)) return err({ code: 'access.denied' });
  const body = closed(input, LIST_KEYS);
  if (!body.ok) return body;
  const request = paymentsRequestOf(body.value);
  if (!request.ok) return request;
  const list = parseListQuery(body.value, PAYMENT_SPEC);
  if (!list.ok) return list;
  const read = await deps.ordering.adminCustomerPayments(context, {
    query: request.value.query,
    order: { sort: list.value.sort, direction: list.value.direction },
    window: pageWindow(list.value),
    withTotal: list.value.paging === 'pages',
  });
  if (!read.ok) return err(fromOrdering(read.error.code));
  const page = listPage(read.value.rows, list.value, read.value.total);
  return ok({ ...page, items: page.items.map(paymentView), paid: read.value.paid });
}

// ---- disputes -------------------------------------------------------------------------------

function disputesQueryOf(
  input: Record<string, unknown>,
): Result<
  { accountId: Id<'Account'>; filters: Omit<OrdersDisputeQuery, 'orderIds'> },
  ListQueryFailure
> {
  const accountId = accountOf(input);
  if (!accountId.ok) return accountId;
  const raw = filtersOf(input, ['status', 'from', 'to']);
  if (!raw.ok) return raw;
  const statuses = parseClosedValues(raw.value['status'], DISPUTE_STATUSES, 'filters.status');
  if (!statuses.ok) return statuses;
  const range = parseInstantRange(raw.value);
  if (!range.ok) return range;
  return ok({ accountId: accountId.value, filters: { statuses: statuses.value, ...range.value } });
}

const disputeView = (row: DisputeRecord): CustomerDisputeView => ({
  disputeId: row.id,
  orderId: row.orderId,
  status: row.status,
  reason: row.reason,
  amount: { amount: row.amountMinor, currency: row.currency },
  openedAt: row.openedAt.toString(),
  evidenceDueBy: row.evidenceDueBy === null ? null : row.evidenceDueBy.toString(),
  outcome: row.outcome,
});

/** The customer's order ids (ordering's answer), refusing a customer with too many orders. */
async function customerOrderIds(
  deps: CustomerPaymentsDependencies,
  context: CallContext,
  accountId: Id<'Account'>,
): Promise<Result<readonly string[], CustomerPaymentsFailure>> {
  const ids = await deps.ordering.adminCustomerOrderIds(context, {
    accountId,
    limit: DISPUTE_ORDER_SCAN + 1,
  });
  if (!ids.ok) return err(fromOrdering(ids.error.code));
  if (ids.value.length > DISPUTE_ORDER_SCAN) {
    return err({ code: 'batch.too-large', max: DISPUTE_ORDER_SCAN });
  }
  return ok(ids.value);
}

/** One page of the disputes of a customer's orders, newest opened first by default. */
export async function readCustomerDisputes(
  deps: CustomerPaymentsDependencies,
  context: CallContext,
  input: unknown,
): Promise<Result<ListPage<CustomerDisputeView>, CustomerPaymentsFailure>> {
  if (!isAdmin(context)) return err({ code: 'access.denied' });
  const body = closed(input, LIST_KEYS);
  if (!body.ok) return body;
  const request = disputesQueryOf(body.value);
  if (!request.ok) return request;
  const list = parseListQuery(body.value, DISPUTE_SPEC);
  if (!list.ok) return list;
  const orderIds = await customerOrderIds(deps, context, request.value.accountId);
  if (!orderIds.ok) return orderIds;
  const query: OrdersDisputeQuery = { orderIds: orderIds.value, ...request.value.filters };
  const read = await deps.unitOfWork.run(
    context.market,
    async () => {
      const [rows, total] = await Promise.all([
        deps.disputes.pageOfOrders(
          context.market,
          query,
          { sort: list.value.sort, direction: list.value.direction },
          pageWindow(list.value),
        ),
        list.value.paging === 'pages'
          ? deps.disputes.countOfOrders(context.market, query)
          : Promise.resolve(null),
      ]);
      return ok({ rows, total });
    },
    { readOnly: true },
  );
  if (!read.ok) return err({ code: 'access.unavailable' });
  const page = listPage(read.value.rows, list.value, read.value.total);
  return ok({ ...page, items: page.items.map(disputeView) });
}

// ---- exports --------------------------------------------------------------------------------

/**
 * Spends the step-up proof and writes the audit row in one unit, after the rows were read: a
 * refused proof releases no file. The audit row holds the format and the count only.
 */
async function releaseExport(
  deps: CustomerPaymentsDependencies,
  context: CallContext,
  entry: (proof: ConsumedStepUp) => AuditEntry,
): Promise<Result<true, CustomerPaymentsFailure>> {
  return deps.unitOfWork.run<true, CustomerPaymentsFailure>(context.market, async () => {
    const spent = await deps.stepUp.consume(context, CUSTOMER_DATA_EXPORT_STEP_UP);
    if (!spent.ok) {
      const refusal = spent.error;
      if (
        refusal.code === 'second-factor.required' ||
        refusal.code === 'second-factor.enrolment-required'
      ) {
        return err({ code: refusal.code, actionKey: refusal.actionKey });
      }
      return err({
        code: refusal.code === 'access.unavailable' ? 'access.unavailable' : 'access.denied',
      });
    }
    await deps.audit.record(context, entry(spent.value));
    return ok(true);
  });
}

function fileOf(
  deps: CustomerPaymentsDependencies,
  format: ExportFormat,
  baseName: string,
  sheetName: string,
  rows: readonly (readonly ExportCell[])[],
): ExportFile {
  return buildExportFile({
    format,
    baseName,
    sheetName,
    day: deps.clock.now().toString().slice(0, 10),
    groups: fromArray([rows]),
    sheetWriter: deps.sheetWriter,
  });
}

/** A customer's payments (the request's filters and order) as CSV or XLSX, at most 10,000. */
export async function exportCustomerPayments(
  deps: CustomerPaymentsDependencies,
  context: CallContext,
  input: unknown,
): Promise<Result<ExportFile, CustomerPaymentsFailure>> {
  if (!isAdmin(context)) return err({ code: 'access.denied' });
  const body = closed(input, EXPORT_KEYS);
  if (!body.ok) return body;
  const format = parseExportFormat(body.value['format']);
  if (!format.ok) return format;
  const request = paymentsRequestOf(body.value);
  if (!request.ok) return request;
  const list = parseListQuery(
    { sort: body.value['sort'], direction: body.value['direction'] },
    PAYMENT_SPEC,
  );
  if (!list.ok) return list;
  const read = await deps.ordering.adminCustomerPayments(context, {
    query: request.value.query,
    order: { sort: list.value.sort, direction: list.value.direction },
    window: { offset: 0, limit: LIST_EXPORT_MAX_ROWS + 1 },
    withTotal: false,
  });
  if (!read.ok) return err(fromOrdering(read.error.code));
  const fits = checkExportSize(read.value.rows.length);
  if (!fits.ok) return fits;
  const released = await releaseExport(deps, context, (proof) =>
    CustomerPaymentsExported.entry(request.value.accountId, {
      after: {
        format: format.value,
        rowCount: read.value.rows.length,
        stepUpSessionId: proof.sessionId,
        stepUpVerifiedAt: proof.verifiedAt,
      },
    }),
  );
  if (!released.ok) return released;
  const header: ExportCell[] = [
    'Order',
    'Status',
    'Payment state',
    'Amount (minor units)',
    'Currency',
    'Provider payment id',
    'Created at',
    'Confirmed at',
  ];
  const rows = read.value.rows
    .map(paymentView)
    .map((view): ExportCell[] => [
      view.orderId,
      view.status,
      view.paymentState,
      view.amount.amount.toString(),
      view.amount.currency,
      view.providerPaymentId ?? '',
      view.createdAt,
      view.confirmedAt ?? '',
    ]);
  return ok(fileOf(deps, format.value, 'customer-payments', 'Payments', [header, ...rows]));
}

/** A customer's disputes (the request's filters and order) as CSV or XLSX, at most 10,000. */
export async function exportCustomerDisputes(
  deps: CustomerPaymentsDependencies,
  context: CallContext,
  input: unknown,
): Promise<Result<ExportFile, CustomerPaymentsFailure>> {
  if (!isAdmin(context)) return err({ code: 'access.denied' });
  const body = closed(input, EXPORT_KEYS);
  if (!body.ok) return body;
  const format = parseExportFormat(body.value['format']);
  if (!format.ok) return format;
  const request = disputesQueryOf(body.value);
  if (!request.ok) return request;
  const list = parseListQuery(
    { sort: body.value['sort'], direction: body.value['direction'] },
    DISPUTE_SPEC,
  );
  if (!list.ok) return list;
  const orderIds = await customerOrderIds(deps, context, request.value.accountId);
  if (!orderIds.ok) return orderIds;
  const query: OrdersDisputeQuery = { orderIds: orderIds.value, ...request.value.filters };
  const read = await deps.unitOfWork.run(
    context.market,
    async () =>
      ok(
        await deps.disputes.pageOfOrders(
          context.market,
          query,
          { sort: list.value.sort, direction: list.value.direction },
          { offset: 0, limit: LIST_EXPORT_MAX_ROWS + 1 },
        ),
      ),
    { readOnly: true },
  );
  if (!read.ok) return err({ code: 'access.unavailable' });
  const fits = checkExportSize(read.value.length);
  if (!fits.ok) return fits;
  const released = await releaseExport(deps, context, (proof) =>
    CustomerDisputesExported.entry(request.value.accountId, {
      after: {
        format: format.value,
        rowCount: read.value.length,
        stepUpSessionId: proof.sessionId,
        stepUpVerifiedAt: proof.verifiedAt,
      },
    }),
  );
  if (!released.ok) return released;
  const header: ExportCell[] = [
    'Dispute',
    'Order',
    'Status',
    'Reason',
    'Amount (minor units)',
    'Currency',
    'Opened at',
    'Evidence due by',
    'Outcome',
  ];
  const rows = read.value
    .map(disputeView)
    .map((view): ExportCell[] => [
      view.disputeId,
      view.orderId,
      view.status,
      view.reason,
      view.amount.amount.toString(),
      view.amount.currency,
      view.openedAt,
      view.evidenceDueBy ?? '',
      view.outcome ?? '',
    ]);
  return ok(fileOf(deps, format.value, 'customer-disputes', 'Disputes', [header, ...rows]));
}

async function* fromArray<T>(items: readonly T[]): AsyncGenerator<T> {
  for (const item of items) yield await Promise.resolve(item);
}
