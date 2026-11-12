import { countPlan, type PlanCounts, type PlannedRow } from './import-plan';
import type { Prepared } from './import-prepare';
import type { AttributeFileKind } from './file-layout';

/** The rows the check shows: the errors first, then the rows that would change something. */
export const VIEW_ROWS = 200;

export interface ImportCheckView {
  readonly counts: PlanCounts;
  readonly kind: AttributeFileKind;
  /** Hex SHA-256 of the file; the run names it, so it applies exactly what was checked. */
  readonly fileSha256: string;
  readonly planSha256: string;
  /** Headers of the file that were not read. */
  readonly ignoredColumns: readonly string[];
  /** True when at least one row would write something. */
  readonly canRun: boolean;
  readonly rows: readonly PlannedRow[];
  /** True when more rows would be shown than {@link VIEW_ROWS}. */
  readonly truncated: boolean;
}

export function checkViewOf(prepared: Prepared): ImportCheckView {
  const { rows, writes } = prepared.plan;
  const shown = [
    ...rows.filter((row) => row.action === 'error'),
    ...rows.filter((row) => row.action === 'create' || row.action === 'update'),
  ];
  return {
    counts: countPlan(rows),
    kind: prepared.kind,
    fileSha256: prepared.fileSha256,
    planSha256: prepared.planSha256,
    ignoredColumns: prepared.ignoredColumns,
    canRun: writes.length > 0,
    rows: shown.slice(0, VIEW_ROWS),
    truncated: shown.length > VIEW_ROWS,
  };
}
