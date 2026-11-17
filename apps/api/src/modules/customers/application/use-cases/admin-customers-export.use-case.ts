import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import { CSV_BOM, csvLine } from '@mondapac/platform-import';
import {
  UseCase,
  type AccessDeclaration,
  type StepUpProofConsumer,
  type UseCaseGate,
} from '../../../../platform/authz';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CUSTOMERS_CUSTOMER_EXPORT, CUSTOMERS_CUSTOMER_VIEW } from '../../contracts/permissions';
import { CUSTOMERS_EXPORT_STEP_UP } from '../../contracts/step-up';
import { CustomersExported } from '../../domain/audit';
import { CUSTOMER_EXPORT_MAX_ROWS } from '../../domain/customer-list';
import {
  CUSTOMER_EXPORT_COLUMNS,
  CUSTOMER_EXPORT_HEADERS,
  exportCell,
  type CustomerExportColumn,
} from '../customer-export';
import {
  adminAccountOf,
  invalidField,
  isRecord,
  selectorOfRequest,
  type ListValidationFailure,
} from '../customer-list-flow';
import type { AdminDayZone } from '../ports/admin-day-zone';
import type { CustomerListReader } from '../ports/customer-list.reader';
import { XLSX_CONTENT_TYPE, type SheetWriter } from '../ports/sheet-writer';

/** Customers read per chunk while the file streams. */
const CHUNK = 500;
/** Ids one request may name (the page's selection); "select all" goes by the filter instead. */
const MAX_IDS = 1000;

export interface AdminCustomersExportDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly listReader: CustomerListReader;
  readonly sheetWriter: SheetWriter;
  readonly audit: AuditWriter;
  readonly stepUp: StepUpProofConsumer;
  readonly clock: Clock;
  /** The zone the day filters are read in (the admin's, else the Market's). */
  readonly dayZone: AdminDayZone;
}

export interface AdminCustomersExportOutput {
  readonly filename: string;
  readonly contentType: string;
  /** The file in chunks: text for a CSV, bytes for an XLSX. The first chunk holds the header. */
  readonly chunks: AsyncIterable<string | Uint8Array>;
}

export type AdminCustomersExportFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'second-factor.required'; readonly actionKey?: string }
  | { readonly code: 'second-factor.enrolment-required'; readonly actionKey?: string }
  | { readonly code: 'batch.too-large'; readonly max: number; readonly total?: number }
  | ListValidationFailure;

const OWN_KEYS = new Set(['format', 'columns', 'ids', 'view', 'q', 'filters']);

/**
 * `customers.admin-customers-export`: the customers of the list as a CSV or XLSX file. Rule: the
 * protected key `customers.customers.export` and the admin population, and a fresh two-step proof
 * of `customers.customers.export`, spent in the unit that picks the customers and writes the audit
 * row (a refusal commits nothing). The customers are the named `ids` (at most 1000) or what the
 * list's `view`, `q` and `filters` match, at most 10,000 (more is refused whole). `columns` picks
 * the optional columns in the order given; email is always first. The audit row holds the format,
 * the count and how the customers were picked, never the search text or a filter value. The answer
 * is a stream of chunks that each read their own page (a read-only unit). CSV: a text cell that a
 * spreadsheet would run as a formula gets a leading quote. XLSX: every cell is a string value.
 */
export class AdminCustomersExport extends UseCase<
  unknown,
  AdminCustomersExportOutput,
  AdminCustomersExportFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'customers.admin-customers-export',
    rule: {
      kind: 'permissions',
      allOf: [CUSTOMERS_CUSTOMER_VIEW.key, CUSTOMERS_CUSTOMER_EXPORT.key],
    },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminCustomersExportDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<AdminCustomersExportOutput, AdminCustomersExportFailure>> {
    if (adminAccountOf(context) === null) return err({ code: 'access.denied' });
    if (!isRecord(input)) return invalidField('body', 'type');
    for (const key of Object.keys(input)) {
      if (!OWN_KEYS.has(key)) return invalidField(key, 'unknown');
    }
    const format = input['format'] ?? 'csv';
    if (format !== 'csv' && format !== 'xlsx') return invalidField('format', 'value');
    const columns = columnsOf(input['columns']);
    if (!columns.ok) return columns;

    let requestedIds: readonly Id<'Account'>[] | null = null;
    if (input['ids'] !== undefined) {
      const named = idsOf(input['ids']);
      if (!named.ok) return named;
      requestedIds = named.value;
    }
    const selector = selectorOfRequest(input);
    if (!selector.ok) return selector;

    const { deps } = this;
    const { market } = context;
    const now = deps.clock.now();
    const query = { selector: selector.value, now, zone: await deps.dayZone.zoneOf(context) };

    const picked = await deps.unitOfWork.run<
      { readonly ids: readonly Id<'Account'>[] },
      AdminCustomersExportFailure
    >(market, async () => {
      // The proof first: a refusal commits nothing, and nothing is read for an admin who has none.
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
      let ids: readonly Id<'Account'>[];
      if (requestedIds !== null) {
        // An id that is not a customer of this Market is dropped, so the file never names one.
        const rows = await deps.listReader.rowsByIds(market, requestedIds);
        ids = rows.map((row) => row.accountId);
      } else {
        ids = await deps.listReader.ids(market, query, CUSTOMER_EXPORT_MAX_ROWS + 1);
        if (ids.length > CUSTOMER_EXPORT_MAX_ROWS) {
          const total = await deps.listReader.count(market, query);
          return err({ code: 'batch.too-large', max: CUSTOMER_EXPORT_MAX_ROWS, total });
        }
      }
      await deps.audit.record(
        context,
        CustomersExported.entry('customers-export', {
          after: {
            format,
            rowCount: ids.length,
            selection: requestedIds !== null ? 'ids' : 'filter',
            stepUpSessionId: spent.value.sessionId,
            stepUpVerifiedAt: spent.value.verifiedAt,
          },
        }),
      );
      return ok({ ids });
    });
    if (!picked.ok) return picked;

    const day = now.toString().slice(0, 10);
    const rows = this.#rows(context, picked.value.ids, columns.value);
    if (format === 'xlsx') {
      return ok({
        filename: `customers-${day}.xlsx`,
        contentType: XLSX_CONTENT_TYPE,
        chunks: deps.sheetWriter.xlsx('Customers', flat(rows)),
      });
    }
    return ok({
      filename: `customers-${day}.csv`,
      contentType: 'text/csv; charset=utf-8',
      chunks: csvChunks(rows),
    });
  }

  /** The rows of the file, a group per page of customers: the header group first. */
  async *#rows(
    context: CallContext,
    ids: readonly Id<'Account'>[],
    columns: readonly CustomerExportColumn[],
  ): AsyncGenerator<readonly (readonly string[])[]> {
    const { deps } = this;
    yield [
      [CUSTOMER_EXPORT_HEADERS.email, ...columns.map((column) => CUSTOMER_EXPORT_HEADERS[column])],
    ];
    for (let start = 0; start < ids.length; start += CHUNK) {
      const chunk = ids.slice(start, start + CHUNK);
      const read = await deps.unitOfWork.run(
        context.market,
        async () => ok(await deps.listReader.rowsByIds(context.market, chunk)),
        { readOnly: true },
      );
      if (!read.ok) throw new Error('customers.admin-customers-export: the read failed');
      yield read.value.map((row) => [
        row.email,
        ...columns.map((column) => exportCell(column, row)),
      ]);
    }
  }
}

async function* flat(
  groups: AsyncIterable<readonly (readonly string[])[]>,
): AsyncGenerator<readonly string[]> {
  for await (const group of groups) for (const row of group) yield row;
}

async function* csvChunks(
  groups: AsyncIterable<readonly (readonly string[])[]>,
): AsyncGenerator<string> {
  let first = true;
  for await (const group of groups) {
    const text = group.map((row) => csvLine(row)).join('');
    yield first ? CSV_BOM + text : text;
    first = false;
  }
}

function columnsOf(value: unknown): Result<readonly CustomerExportColumn[], ListValidationFailure> {
  if (value === undefined) return ok(CUSTOMER_EXPORT_COLUMNS);
  if (!Array.isArray(value) || value.length > CUSTOMER_EXPORT_COLUMNS.length) {
    return invalidField('columns', 'type');
  }
  const seen = new Set<CustomerExportColumn>();
  for (const part of value as unknown[]) {
    const column = CUSTOMER_EXPORT_COLUMNS.find((known) => known === part);
    if (column === undefined || seen.has(column)) return invalidField('columns', 'value');
    seen.add(column);
  }
  return ok([...seen]);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function idsOf(
  value: unknown,
): Result<
  readonly Id<'Account'>[],
  ListValidationFailure | { readonly code: 'batch.too-large'; readonly max: number }
> {
  if (!Array.isArray(value)) return invalidField('ids', 'type');
  if (value.length === 0) return invalidField('ids', 'required');
  if (value.length > MAX_IDS) return err({ code: 'batch.too-large', max: MAX_IDS });
  const out = new Set<string>();
  for (const part of value as unknown[]) {
    if (typeof part !== 'string' || !UUID.test(part)) return invalidField('ids', 'format');
    out.add(part);
  }
  return ok([...out] as Id<'Account'>[]);
}
