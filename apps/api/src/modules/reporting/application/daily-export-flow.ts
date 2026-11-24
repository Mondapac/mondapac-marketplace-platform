import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result, Temporal } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import {
  buildExportFile,
  parseExportFormat,
  type ExportCell,
  type ExportFile,
  type ExportFormat,
  type ExportInputFailure,
  type SheetWriter,
} from '../../../platform/list-export';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import { AUDIT_PERIOD } from '../domain/audit';
import type { DailyExportCell } from '../domain/daily-export';
import { marketDayOf } from '../domain/facts';
import {
  dayStartsOf,
  parsePeriodQuery,
  resolvePeriodRequest,
  type DayRange,
  type PeriodId,
  type PeriodRefused,
} from '../domain/period';
import type { MarketZone } from './ports/market-zone';

/** What an export needs besides its reader and its audit row. */
export interface DailyExportDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly zone: MarketZone;
  readonly clock: Clock;
  readonly sheetWriter: SheetWriter;
}

export type DailyExportFailure = AccessDenied | PeriodRefused | ExportInputFailure;

/** The range of an export as its audit row names it (never a figure of the file). */
export interface ExportedRange {
  readonly period: (typeof AUDIT_PERIOD)[keyof typeof AUDIT_PERIOD];
  /** The start of the first day in the Market's zone. */
  readonly rangeStart: Temporal.Instant;
  /** The start of the day after the last (exclusive). */
  readonly rangeEnd: Temporal.Instant;
  readonly days: number;
  readonly format: ExportFormat;
  readonly rowCount: number;
}

export interface DailyExportSpec {
  /** The preset used when the query names neither a period nor a range. */
  readonly fallback: PeriodId;
  /** The file name before the range, for example `marketplace-daily`. */
  readonly baseName: string;
  readonly sheetName: string;
  readonly header: readonly string[];
  /** The rows of the range in the Market's currency, read in the export's unit. */
  readonly rows: (range: DayRange, currency: string) => Promise<DailyExportCell[][]>;
  /** Writes the audit row in the export's unit; a refusal throws and rolls the unit back. */
  readonly audit: (range: ExportedRange) => Promise<void>;
}

const QUERY_KEYS = new Set(['period', 'from', 'to', 'format']);
const logger = new Logger('DailyExport');

const refused = (fields: PeriodRefused['fields']): { ok: false; error: PeriodRefused } => ({
  ok: false,
  error: { code: 'validation.failed', fields },
});

/**
 * A daily export (dashboards v2, PR 5): the query (`period` or `from`/`to`, `format`; any other
 * key is refused), the range on the Market's today (at most 13 months, ending by today), then one
 * read-write unit that reads the rows and writes the audit row, so no file leaves unaudited. The
 * file is the shared list export's (CSV with the formula guard and a byte order mark, or XLSX with
 * every cell as text). The caller has checked the actor and the keys.
 */
export async function dailyExport(
  deps: DailyExportDependencies,
  context: CallContext,
  input: unknown,
  spec: DailyExportSpec,
): Promise<Result<ExportFile, DailyExportFailure>> {
  const query = (typeof input === 'object' && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  const unknown = Object.keys(query)
    .filter((key) => !QUERY_KEYS.has(key))
    .sort()
    .slice(0, 10);
  if (unknown.length > 0) {
    return err({
      code: 'validation.failed',
      fields: unknown.map((key) => ({ path: key.slice(0, 64), code: 'unknown-field' })),
    });
  }
  const format = parseExportFormat(query['format']);
  if (!format.ok) return format;
  const asked = parsePeriodQuery(
    { period: query['period'], from: query['from'], to: query['to'] },
    spec.fallback,
  );
  if (!asked.ok) return refused(asked.error);
  const { market } = context;
  const timezone = deps.zone.zoneOf(market);
  const currency = deps.zone.currencyOf(market);
  const resolved = resolvePeriodRequest(asked.value, marketDayOf(deps.clock.now(), timezone));
  if (!resolved.ok) return refused(resolved.error);
  const period = resolved.value;
  try {
    const unit = await deps.unitOfWork.run<DailyExportCell[][], DailyExportFailure>(
      market,
      async () => {
        const rows = await spec.rows(period.current, currency);
        const { start, end } = dayStartsOf(period.current, timezone);
        await spec.audit({
          period: AUDIT_PERIOD[period.id],
          rangeStart: start,
          rangeEnd: end,
          days: period.days,
          format: format.value,
          rowCount: rows.length,
        });
        return ok(rows);
      },
    );
    if (!unit.ok) return unit;
    const lines: (readonly ExportCell[])[] = [spec.header, ...unit.value];
    return ok(
      buildExportFile({
        format: format.value,
        baseName: `${spec.baseName}-${period.current.from}`,
        sheetName: spec.sheetName,
        day: period.current.to,
        groups: once(lines),
        sheetWriter: deps.sheetWriter,
      }),
    );
  } catch (error) {
    // The class only: a store error may carry a statement or a value.
    logger.error({
      msg: 'reporting.daily-export.failed',
      errorClass: error instanceof Error ? error.constructor.name : typeof error,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return err({ code: 'access.unavailable' });
  }
}

async function* once<T>(group: T): AsyncGenerator<T> {
  yield await Promise.resolve(group);
}
