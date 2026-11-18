import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, Result } from '@mondapac/shared-kernel';
import { CSV_BOM, csvLine } from '@mondapac/platform-import';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { StepUpProofConsumer } from '../../../platform/authz';
import {
  listPage,
  pageWindow,
  parseListQuery,
  type ListPage,
  type ListQuerySpec,
  type SortDirection,
} from '../../../platform/list-query';
import type { SecurityEvents } from '../../../platform/security-events/security-events';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import { CUSTOMERS_EXPORT_STEP_UP } from '../contracts/step-up';
import { CustomerSectionExported, type CustomerSectionName } from '../domain/audit';
import {
  adminAccountOf,
  invalidField,
  isRecord,
  type ListValidationFailure,
} from './customer-list-flow';
import { accountIdOf } from './customer-page-flow';
import type { AdminActionLimits } from './ports/admin-action-limits';
import type { CustomerListReader } from './ports/customer-list.reader';
import type { CustomerSectionPeers } from './ports/customer-section-peers';
import type { CustomerTimelineRepository } from './ports/customer-timeline.repository';
import { XLSX_CONTENT_TYPE, type SheetWriter } from './ports/sheet-writer';

// The customer page's sections that other modules own (customers management phase 2b): each is
// one facade read of its owner, behind the owner's own key, which customers composes lazily, one
// route per section. A section that can hold more than 50 rows is a super list (CLAUDE.md rule
// 14): POST with `filters`, `sort`, `direction`, both paging modes, and an export (CSV or XLSX, at
// most 10,000 rows) behind `customers.customers.export` and a fresh step-up proof of it, spent in
// the unit that writes the audit row `customers.customer-section.exported` (the section, format
// and count). This file is that shared machinery; each section declares what its rows are.

export interface CustomerSectionDependencies {
  readonly unitOfWork: UnitOfWork;
  /** The customer directory: a section is read only for a customer of the Market. */
  readonly listReader: Pick<CustomerListReader, 'rowsByIds'>;
  readonly timeline: Pick<CustomerTimelineRepository, 'record'>;
  readonly audit: AuditWriter;
  readonly stepUp: StepUpProofConsumer;
  readonly sheetWriter: SheetWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** The per-admin limits of the reveal and the password reset (security review of #969). */
  readonly adminLimits: AdminActionLimits;
  /** customers' own security event recorder: the bulk-reveal alert. */
  readonly securityEvents: SecurityEvents;
  /** The owning modules' facades, bound at start; each call fails closed until then. */
  readonly peers: CustomerSectionPeers;
}

export type CustomerSectionFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'customers.customer-not-found' }
  | { readonly code: 'second-factor.required'; readonly actionKey?: string }
  | { readonly code: 'second-factor.enrolment-required'; readonly actionKey?: string }
  | { readonly code: 'batch.too-large'; readonly max: number; readonly total?: number }
  | ListValidationFailure;

/** The rows one export may hold; more is refused whole and the admin narrows the filters. */
export const SECTION_EXPORT_MAX = 10_000;

/** What a section asks its owner for: the filters it parsed, the order and the rows. */
export interface SectionReadRequest<F, S extends string> {
  readonly accountId: Id<'Account'>;
  readonly filters: F;
  readonly sort: S;
  readonly direction: SortDirection;
  readonly window: { readonly offset: number; readonly limit: number };
  /** Count every match (page-number mode); false in Previous and Next mode and for an export. */
  readonly withTotal: boolean;
}

/** The owner's answer: the rows, the total when asked, and anything the page shows beside them. */
export interface SectionReadAnswer<R> {
  readonly rows: readonly R[];
  readonly total: number | null;
  readonly extra?: Readonly<Record<string, unknown>>;
}

/** One super-list section of the customer page. */
export interface SectionListSpec<F, S extends string, R> {
  readonly section: CustomerSectionName;
  /** The keys `filters` may hold. */
  readonly filterKeys: readonly string[];
  readonly parseFilters: (
    raw: Readonly<Record<string, unknown>>,
  ) => Result<F, ListValidationFailure>;
  readonly query: ListQuerySpec<S>;
  readonly read: (
    peers: CustomerSectionPeers,
    context: CallContext,
    request: SectionReadRequest<F, S>,
  ) => Promise<Result<SectionReadAnswer<R>, { readonly code: string }>>;
  /** The export: the file's base name, its sheet, the header and one row's cells. */
  readonly sheet: {
    readonly baseName: string;
    readonly name: string;
    readonly header: readonly string[];
    readonly cells: (row: R) => readonly (string | number | null)[];
  };
}

const LIST_KEYS = ['accountId', 'filters', 'sort', 'direction', 'page', 'pageSize', 'paging'];
const EXPORT_KEYS = ['accountId', 'filters', 'format', 'sort', 'direction'];

/** An owner's refusal as the customer page answers it: a denial stays one, anything else unavailable. */
export const fromOwner = (code: string): CustomerSectionFailure =>
  code === 'access.denied' ? { code: 'access.denied' } : { code: 'access.unavailable' };

function closed(
  input: unknown,
  keys: readonly string[],
): Result<Record<string, unknown>, CustomerSectionFailure> {
  if (!isRecord(input)) return invalidField('body', 'type');
  for (const key of Object.keys(input))
    if (!keys.includes(key)) return invalidField(key, 'unknown');
  return ok(input);
}

function filtersOf<F>(
  input: Record<string, unknown>,
  spec: Pick<SectionListSpec<F, string, unknown>, 'filterKeys' | 'parseFilters'>,
): Result<F, CustomerSectionFailure> {
  const raw = input['filters'] ?? {};
  if (!isRecord(raw)) return invalidField('filters', 'type');
  for (const key of Object.keys(raw)) {
    if (!spec.filterKeys.includes(key)) return invalidField(`filters.${key}`, 'unknown');
  }
  return spec.parseFilters(raw);
}

/**
 * The admin, the customer's account id and the check that the account is a customer of the
 * Market's directory (an erased or unknown id, another Market's and a seller's are not found).
 */
export async function customerOf(
  deps: Pick<CustomerSectionDependencies, 'unitOfWork' | 'listReader'>,
  context: CallContext,
  rawAccountId: unknown,
): Promise<
  Result<
    { readonly admin: Id<'Account'>; readonly accountId: Id<'Account'> },
    CustomerSectionFailure
  >
> {
  const admin = adminAccountOf(context);
  if (admin === null) return err({ code: 'access.denied' });
  const accountId = accountIdOf(rawAccountId);
  if (accountId === null) return err({ code: 'customers.customer-not-found' });
  const known = await deps.unitOfWork.run(
    context.market,
    async () => ok((await deps.listReader.rowsByIds(context.market, [accountId])).length === 1),
    { readOnly: true },
  );
  if (!known.ok) return err({ code: 'access.unavailable' });
  if (!known.value) return err({ code: 'customers.customer-not-found' });
  return ok({ admin, accountId });
}

/**
 * One read of a section that is not a list (the cart, the behaviour summary, the consent): the
 * body names the account only; the owner's answer is shaped by `answer`.
 */
export async function readSectionItem<T, A>(
  deps: Pick<CustomerSectionDependencies, 'unitOfWork' | 'listReader' | 'peers'>,
  context: CallContext,
  input: unknown,
  read: (
    peers: CustomerSectionPeers,
    accountId: Id<'Account'>,
  ) => Promise<Result<T, { readonly code: string }>>,
  answer: (value: T) => A,
): Promise<Result<A, CustomerSectionFailure>> {
  if (adminAccountOf(context) === null) return err({ code: 'access.denied' });
  const body = closed(input, ['accountId']);
  if (!body.ok) return body;
  const customer = await customerOf(deps, context, body.value['accountId']);
  if (!customer.ok) return customer;
  const value = await read(deps.peers, customer.value.accountId);
  if (!value.ok) return err(fromOwner(value.error.code));
  return ok(answer(value.value));
}

/** One page of a section, with the owner's extra fields beside the page. */
export async function readSectionList<F, S extends string, R>(
  deps: CustomerSectionDependencies,
  spec: SectionListSpec<F, S, R>,
  context: CallContext,
  input: unknown,
): Promise<Result<ListPage<R> & Readonly<Record<string, unknown>>, CustomerSectionFailure>> {
  if (adminAccountOf(context) === null) return err({ code: 'access.denied' });
  const body = closed(input, LIST_KEYS);
  if (!body.ok) return body;
  const filters = filtersOf(body.value, spec);
  if (!filters.ok) return filters;
  const list = parseListQuery(body.value, spec.query);
  if (!list.ok) return list;
  const customer = await customerOf(deps, context, body.value['accountId']);
  if (!customer.ok) return customer;
  const read = await spec.read(deps.peers, context, {
    accountId: customer.value.accountId,
    filters: filters.value,
    sort: list.value.sort,
    direction: list.value.direction,
    window: pageWindow(list.value),
    withTotal: list.value.paging === 'pages',
  });
  if (!read.ok) return err(fromOwner(read.error.code));
  return ok({
    ...(read.value.extra ?? {}),
    ...listPage(read.value.rows, list.value, read.value.total),
  });
}

export interface SectionExportFile {
  readonly filename: string;
  readonly contentType: string;
  readonly chunks: AsyncIterable<string | Uint8Array>;
}

/**
 * A section's rows (the request's filters and order) as CSV or XLSX, at most 10,000. The rows are
 * read first; then one unit spends the step-up proof and writes the audit row, and only after it
 * commits is the file built: a refused proof releases nothing.
 */
export async function exportSectionList<F, S extends string, R>(
  deps: CustomerSectionDependencies,
  spec: SectionListSpec<F, S, R>,
  context: CallContext,
  input: unknown,
): Promise<Result<SectionExportFile, CustomerSectionFailure>> {
  if (adminAccountOf(context) === null) return err({ code: 'access.denied' });
  const body = closed(input, EXPORT_KEYS);
  if (!body.ok) return body;
  const format = body.value['format'] ?? 'csv';
  if (format !== 'csv' && format !== 'xlsx') return invalidField('format', 'value');
  const filters = filtersOf(body.value, spec);
  if (!filters.ok) return filters;
  const order = parseListQuery(
    { sort: body.value['sort'], direction: body.value['direction'] },
    spec.query,
  );
  if (!order.ok) return order;
  const customer = await customerOf(deps, context, body.value['accountId']);
  if (!customer.ok) return customer;
  const { accountId } = customer.value;
  const read = await spec.read(deps.peers, context, {
    accountId,
    filters: filters.value,
    sort: order.value.sort,
    direction: order.value.direction,
    window: { offset: 0, limit: SECTION_EXPORT_MAX + 1 },
    withTotal: false,
  });
  if (!read.ok) return err(fromOwner(read.error.code));
  const rows = read.value.rows;
  if (rows.length > SECTION_EXPORT_MAX)
    return err({ code: 'batch.too-large', max: SECTION_EXPORT_MAX });
  const released = await deps.unitOfWork.run<true, CustomerSectionFailure>(
    context.market,
    async () => {
      const spent = await deps.stepUp.consume(context, CUSTOMERS_EXPORT_STEP_UP);
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
      await deps.audit.record(
        context,
        CustomerSectionExported.entry(accountId, {
          after: {
            section: spec.section,
            format,
            rowCount: rows.length,
            stepUpSessionId: spent.value.sessionId,
            stepUpVerifiedAt: spent.value.verifiedAt,
          },
        }),
      );
      return ok(true);
    },
  );
  if (!released.ok) return released;
  const lines: (readonly string[])[] = [
    spec.sheet.header,
    ...rows.map((row) => spec.sheet.cells(row).map((cell) => (cell === null ? '' : String(cell)))),
  ];
  const day = deps.clock.now().toString().slice(0, 10);
  if (format === 'xlsx') {
    return ok({
      filename: `${spec.sheet.baseName}-${day}.xlsx`,
      contentType: XLSX_CONTENT_TYPE,
      chunks: deps.sheetWriter.xlsx(spec.sheet.name, fromArray(lines)),
    });
  }
  return ok({
    filename: `${spec.sheet.baseName}-${day}.csv`,
    contentType: 'text/csv; charset=utf-8',
    chunks: fromArray([CSV_BOM + lines.map((line) => csvLine(line)).join('')]),
  });
}

async function* fromArray<T>(items: readonly T[]): AsyncGenerator<T> {
  for (const item of items) yield await Promise.resolve(item);
}
