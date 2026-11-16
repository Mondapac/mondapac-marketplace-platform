import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { PermissionKey, StepUpProofConsumer } from '../../../platform/authz';
import {
  buildExportFile,
  checkExportSize,
  LIST_EXPORT_MAX_ROWS,
  parseExportFormat,
  type ExportCell,
  type ExportFile,
  type ExportTooLarge,
  type SheetWriter,
} from '../../../platform/list-export';
import {
  listPage,
  pageWindow,
  parseClosedValues,
  parseInstantRange,
  parseListQuery,
  MAX_PAGED_ROWS,
  type ListPage,
  type ListQueryFailure,
} from '../../../platform/list-query';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import { CustomerRefundsExported } from '../domain/audit';
import { REFUND_REASONS, type RefundState } from '../domain/refund';
import { isActingAsSession } from './acting-as';
import type { AccountRefundQuery, RefundRepository } from './ports/refund.repository';
import { refundView, type RefundView } from './refund-flow';

// The refunds of one customer's orders as a super list (customers management phase 2b, gap b): the
// customer page's Refunds section. Filters (state, reason, requested between two instants), sort
// (requested, amount), page numbers with a total or Previous and Next (the Market's List paging
// setting) and the CSV/XLSX export behind the customers export key and a fresh two-step proof.
// Ids, codes, amounts and instants only: no Stripe id, no name.

/**
 * The customers view key (declared by `customers`; cast here, pinned by a contract test): every
 * tab of the customer page needs it beside the owning module's own key.
 */
export const CUSTOMER_DATA_VIEW_KEY = 'customers.customers.view' as PermissionKey;
/**
 * The customers export key and its step-up action (declared by `customers`; ordering can only cast
 * the literal, and a contract test pins it to the declaration): exporting a customer's data from
 * the customer page needs it, whichever module owns the rows.
 */
export const CUSTOMER_DATA_EXPORT_KEY = 'customers.customers.export' as PermissionKey;
export const CUSTOMER_DATA_EXPORT_STEP_UP = 'customers.customers.export';

export const REFUND_STATES: readonly RefundState[] = ['pending', 'succeeded', 'failed'];

const SPEC = {
  sorts: ['requested', 'amount'] as const,
  defaultSort: 'requested' as const,
  defaultPageSize: 25,
  maxPageSize: 100,
  maxPage: Math.ceil(MAX_PAGED_ROWS / 25),
};

const FILTER_KEYS = ['state', 'reason', 'from', 'to'];

export type CustomerRefundsFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'second-factor.required'; readonly actionKey?: string }
  | { readonly code: 'second-factor.enrolment-required'; readonly actionKey?: string }
  | ExportTooLarge
  | ListQueryFailure;

export interface CustomerRefundsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly refunds: RefundRepository;
}

export interface CustomerRefundsExportDependencies extends CustomerRefundsDependencies {
  readonly audit: AuditWriter;
  readonly stepUp: StepUpProofConsumer;
  readonly sheetWriter: SheetWriter;
  readonly clock: Clock;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const invalid = (path: string, code: string): { ok: false; error: ListQueryFailure } => ({
  ok: false,
  error: { code: 'validation.failed', fields: [{ path, code }] },
});

/** A platform admin not acting as a seller; the gate checked the key. */
function isAdmin(context: CallContext): boolean {
  const { actor } = context;
  return (
    actor.kind === 'authenticated' && actor.population === 'admin' && !isActingAsSession(actor)
  );
}

/** The account id of the path and the closed filters of a request. */
function queryOf(
  input: Readonly<Record<string, unknown>>,
): Result<AccountRefundQuery, ListQueryFailure> {
  const parsed =
    typeof input['accountId'] === 'string' ? parseId<'Account'>(input['accountId']) : null;
  if (parsed === null || !parsed.ok) return invalid('accountId', 'format');
  const raw = input['filters'] ?? {};
  if (!isRecord(raw)) return invalid('filters', 'type');
  for (const key of Object.keys(raw)) {
    if (!FILTER_KEYS.includes(key)) return invalid(`filters.${key}`, 'unknown');
  }
  const states = parseClosedValues(raw['state'], REFUND_STATES, 'filters.state');
  if (!states.ok) return states;
  const reasons = parseClosedValues(raw['reason'], REFUND_REASONS, 'filters.reason');
  if (!reasons.ok) return reasons;
  const range = parseInstantRange(raw);
  if (!range.ok) return range;
  return ok({
    accountId: parsed.value,
    states: states.value,
    reasons: reasons.value,
    ...range.value,
  });
}

const LIST_KEYS = ['accountId', 'filters', 'sort', 'direction', 'page', 'pageSize', 'paging'];

/**
 * One page of the refunds of one customer's orders, newest first by default. A customer with no
 * order, or of another Market, has none (no not-found: the customer page owns that answer).
 */
export async function readCustomerRefunds(
  deps: CustomerRefundsDependencies,
  context: CallContext,
  input: unknown,
): Promise<Result<ListPage<RefundView>, CustomerRefundsFailure>> {
  if (!isAdmin(context)) return err({ code: 'access.denied' });
  if (!isRecord(input)) return invalid('body', 'type');
  for (const key of Object.keys(input)) {
    if (!LIST_KEYS.includes(key)) return invalid(key, 'unknown');
  }
  const query = queryOf(input);
  if (!query.ok) return query;
  const list = parseListQuery(input, SPEC);
  if (!list.ok) return list;
  const window = pageWindow(list.value);
  const read = await deps.unitOfWork.run(
    context.market,
    async () => {
      const [rows, total] = await Promise.all([
        deps.refunds.pageForAccount(
          context.market,
          query.value,
          { sort: list.value.sort, direction: list.value.direction },
          window,
        ),
        list.value.paging === 'pages'
          ? deps.refunds.countForAccount(context.market, query.value)
          : Promise.resolve(null),
      ]);
      return ok({ rows, total });
    },
    { readOnly: true },
  );
  if (!read.ok) return err({ code: 'access.unavailable' });
  const page = listPage(read.value.rows, list.value, read.value.total);
  return ok({
    ...page,
    items: page.items.map(({ refund, creditNoteId }) => refundView(refund, creditNoteId)),
  });
}

const EXPORT_HEADER: readonly ExportCell[] = [
  'Refund',
  'Order',
  'Seller order',
  'State',
  'Reason',
  'Amount (minor units)',
  'Tax (minor units)',
  'Currency',
  'Requested at',
  'Settled at',
  'Credit note',
];

/**
 * The refunds of one customer's orders (the request's filters and direction) as a CSV or XLSX
 * file, at most 10,000 (more is refused whole). Needs a fresh two-step proof of the customers
 * export action, spent in the unit that reads the rows and writes the audit row.
 */
export async function exportCustomerRefunds(
  deps: CustomerRefundsExportDependencies,
  context: CallContext,
  input: unknown,
): Promise<Result<ExportFile, CustomerRefundsFailure>> {
  if (!isAdmin(context)) return err({ code: 'access.denied' });
  if (!isRecord(input)) return invalid('body', 'type');
  for (const key of Object.keys(input)) {
    if (!['accountId', 'filters', 'format', 'sort', 'direction'].includes(key)) {
      return invalid(key, 'unknown');
    }
  }
  const format = parseExportFormat(input['format']);
  if (!format.ok) return format;
  const query = queryOf(input);
  if (!query.ok) return query;
  const list = parseListQuery({ sort: input['sort'], direction: input['direction'] }, SPEC);
  if (!list.ok) return list;
  const accountId: Id<'Account'> = query.value.accountId;
  const read = await deps.unitOfWork.run<readonly RefundView[], CustomerRefundsFailure>(
    context.market,
    async () => {
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
      const rows = await deps.refunds.pageForAccount(
        context.market,
        query.value,
        { sort: list.value.sort, direction: list.value.direction },
        { offset: 0, limit: LIST_EXPORT_MAX_ROWS + 1 },
      );
      const fits = checkExportSize(
        rows.length,
        rows.length > LIST_EXPORT_MAX_ROWS
          ? await deps.refunds.countForAccount(context.market, query.value)
          : undefined,
      );
      if (!fits.ok) return fits;
      await deps.audit.record(
        context,
        CustomerRefundsExported.entry(accountId, {
          after: {
            format: format.value,
            rowCount: rows.length,
            stepUpSessionId: spent.value.sessionId,
            stepUpVerifiedAt: spent.value.verifiedAt,
          },
        }),
      );
      return ok(rows.map(({ refund, creditNoteId }) => refundView(refund, creditNoteId)));
    },
  );
  if (!read.ok) return read;
  const lines: (readonly ExportCell[])[] = read.value.map((view) => [
    view.refundId,
    view.orderId,
    view.sellerOrderId,
    view.state,
    view.reason,
    view.amount.amount.toString(),
    view.tax.amount.toString(),
    view.amount.currency,
    view.requestedAt.toString(),
    view.settledAt === null ? '' : view.settledAt.toString(),
    view.creditNoteId ?? '',
  ]);
  return ok(
    buildExportFile({
      format: format.value,
      baseName: 'customer-refunds',
      sheetName: 'Refunds',
      day: deps.clock.now().toString().slice(0, 10),
      groups: fromArray([[EXPORT_HEADER, ...lines]]),
      sheetWriter: deps.sheetWriter,
    }),
  );
}

async function* fromArray<T>(items: readonly T[]): AsyncGenerator<T> {
  for (const item of items) yield await Promise.resolve(item);
}
