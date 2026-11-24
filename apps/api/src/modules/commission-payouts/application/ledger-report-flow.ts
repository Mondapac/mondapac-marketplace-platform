// Reporting's reads of the seller ledger (dashboards v2, phase 1, PR 4): the request checks and the
// read-only units behind `CommissionPayoutsReportingFacade`. Rule `system` on both use cases.
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import {
  MAX_LEDGER_REPORT_PAGE,
  MAX_LEDGER_REPORT_SELLER_ORDERS,
  type LedgerReportEntry,
  type LedgerReportFailure,
  type LedgerReportPage,
  type LedgerReportWindow,
} from '../contracts/commission-payouts-reporting.facade';
import type { LedgerReportReader } from './ports/ledger-report.reader';

export interface LedgerReportDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly reader: LedgerReportReader;
}

export interface LedgerReportEntriesInput {
  readonly sellerOrderIds: readonly Id<'SellerOrder'>[];
}

export interface LedgerEntriesRecordedInput {
  readonly window: LedgerReportWindow;
  readonly after: string | null;
  readonly limit: number;
}

const invalid = err({ code: 'validation.failed' } as const);

const isInstant = (value: unknown): value is Temporal.Instant =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { epochNanoseconds?: unknown }).epochNanoseconds === 'bigint';

const idOf = <K extends string>(value: unknown): Id<K> | null => {
  const parsed = typeof value === 'string' ? parseId<K>(value) : null;
  return parsed !== null && parsed.ok ? parsed.value : null;
};

/** The rows of the seller orders: 1 to 100 well-formed, distinct ids, else `validation.failed`. */
export async function ledgerReportEntries(
  deps: LedgerReportDependencies,
  context: CallContext,
  input: LedgerReportEntriesInput,
): Promise<Result<readonly LedgerReportEntry[], LedgerReportFailure>> {
  const asked: unknown = input?.sellerOrderIds;
  if (!Array.isArray(asked) || asked.length === 0 || asked.length > MAX_LEDGER_REPORT_SELLER_ORDERS)
    return invalid;
  const ids: Id<'SellerOrder'>[] = [];
  for (const value of asked as unknown[]) {
    const id = idOf<'SellerOrder'>(value);
    if (id === null) return invalid;
    ids.push(id);
  }
  const distinct = [...new Set(ids)];
  return deps.unitOfWork.run<readonly LedgerReportEntry[], LedgerReportFailure>(
    context.market,
    async () => ok(await deps.reader.entriesOf(context.market, distinct)),
    { readOnly: true },
  );
}

/** One page of rows recorded in the window: a forward window, a well-formed cursor, 1 to 500. */
export async function ledgerEntriesRecorded(
  deps: LedgerReportDependencies,
  context: CallContext,
  input: LedgerEntriesRecordedInput,
): Promise<Result<LedgerReportPage, LedgerReportFailure>> {
  const window = input?.window;
  if (window === undefined || window === null || !isInstant(window.to)) return invalid;
  if (window.from !== null && !isInstant(window.from)) return invalid;
  if (window.from !== null && window.from.epochNanoseconds >= window.to.epochNanoseconds)
    return invalid;
  const limit = input.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LEDGER_REPORT_PAGE) return invalid;
  let after: Id<'LedgerEntry'> | null = null;
  if (input.after !== null) {
    after = idOf<'LedgerEntry'>(input.after);
    if (after === null) return invalid;
  }
  const checked = { from: window.from, to: window.to };
  return deps.unitOfWork.run<LedgerReportPage, LedgerReportFailure>(
    context.market,
    async () => ok(await deps.reader.entriesRecorded(context.market, checked, after, limit)),
    { readOnly: true },
  );
}
