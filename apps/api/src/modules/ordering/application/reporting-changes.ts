// The request check shared by ordering's two reporting change reads (dashboards upgrade phase 3).
import { parseId } from '@mondapac/shared-kernel';
import type { Id, Temporal } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import { MAX_REPORT_CHANGES, type ReportWindow } from '../contracts/ordering-reporting.facade';
import type { ReportingChangesReader } from './ports/reporting-changes.reader';

export interface ReportingChangesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly changes: ReportingChangesReader;
}

export interface ChangesInput {
  readonly window: ReportWindow;
  readonly after: string | null;
  readonly limit: number;
}

export type Checked<T extends string> = {
  readonly window: ReportWindow;
  readonly after: Id<T> | null;
  readonly limit: number;
};

const isInstant = (value: unknown): value is Temporal.Instant =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { epochNanoseconds?: unknown }).epochNanoseconds === 'bigint';

/** The request checked whole: a window that runs forward, a well-formed cursor, a bounded page. */
export function checkChanges<T extends string>(input: ChangesInput): Checked<T> | null {
  const window = input?.window;
  if (window === undefined || window === null || !isInstant(window.to)) return null;
  if (window.from !== null && !isInstant(window.from)) return null;
  if (window.from !== null && window.from.epochNanoseconds >= window.to.epochNanoseconds)
    return null;
  const limit = input.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_REPORT_CHANGES) return null;
  if (input.after === null) return { window, after: null, limit };
  const after = parseId<T>(typeof input.after === 'string' ? input.after : '');
  return after.ok ? { window, after: after.value, limit } : null;
}
