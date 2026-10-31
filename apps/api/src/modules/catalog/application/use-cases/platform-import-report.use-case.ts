import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_PLATFORM_IMPORT_RUN } from '../../contracts/permissions';
import type { ImportJob, ImportRowRecord } from '../../domain/platform-import/platform-import-job';
import { IMPORT_LIMITS } from '../../domain/platform-import/limits';
import { errorReportCsv, fullReportCsv } from '../platform-import/import-report';
import type { ImportCommonFailure } from '../platform-import/common';
import { importIdOf } from '../platform-import/common';
import type { PlatformImportReadDependencies } from './platform-import-read.use-case';

export interface PlatformImportReportInput {
  readonly importId: unknown;
  readonly kind: unknown;
}

export interface PlatformImportReportOutput {
  readonly filename: string;
  readonly contentType: 'text/csv; charset=utf-8';
  readonly body: string;
}

export type PlatformImportReportFailure =
  ImportCommonFailure | { readonly code: 'import.report-unavailable' };

export interface PlatformImportReportDependencies extends PlatformImportReadDependencies {
  readonly clock: Clock;
}

const REPORT_PAGE = 500;

/**
 * `platform-import.report` (design 14a; OFR-16): the two CSV reports of a job. `errors` is the
 * check's error report (every problem of every row with errors), available from the check on;
 * `full` is the run's report (every row and what happened), available once the run finished or
 * stopped. Rule: the key `catalog.platform-import.run`. Each cell that a spreadsheet would run as a
 * formula is written with a leading quote (design 14, AC 41); the file name is not in the report
 * and the download name is built from the date, never from the upload's name.
 */
export class PlatformImportReport extends UseCase<
  PlatformImportReportInput,
  PlatformImportReportOutput,
  PlatformImportReportFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.platform-import-report',
    rule: { kind: 'permissions', allOf: [CATALOG_PLATFORM_IMPORT_RUN.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PlatformImportReportDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: PlatformImportReportInput,
  ): Promise<Result<PlatformImportReportOutput, PlatformImportReportFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const id = importIdOf(input?.importId);
    if (id === null) {
      return err({ code: 'validation.failed', fields: [{ path: 'importId', code: 'format' }] });
    }
    if (input.kind !== 'errors' && input.kind !== 'full') {
      return err({ code: 'validation.failed', fields: [{ path: 'kind', code: 'enum' }] });
    }
    const kind = input.kind;
    const { importJobs } = this.deps;
    const read = await this.deps.unitOfWork.run<
      { job: ImportJob; rows: ImportRowRecord[] },
      PlatformImportReportFailure
    >(
      market,
      async () => {
        const job = await importJobs.find(market, id);
        if (job === null) return err({ code: 'import.not-found' } as const);
        if (kind === 'full' && job.state !== 'finished' && job.state !== 'stopped') {
          return err({ code: 'import.report-unavailable' } as const);
        }
        if (kind === 'errors' && job.state === 'discarded') {
          return err({ code: 'import.report-unavailable' } as const);
        }
        const rows: ImportRowRecord[] = [];
        for (let offset = 0; ; offset += REPORT_PAGE) {
          const page = await importJobs.rows(
            market,
            id,
            kind === 'errors' ? { checkState: 'error' } : {},
            { offset, limit: REPORT_PAGE },
          );
          rows.push(...page);
          if (page.length < REPORT_PAGE || rows.length >= IMPORT_LIMITS.rows) break;
        }
        return ok({ job, rows });
      },
      { readOnly: true },
    );
    if (!read.ok) {
      return read.error.code === 'import.not-found' ||
        read.error.code === 'import.report-unavailable'
        ? read
        : err({ code: 'access.unavailable' });
    }
    const date = this.deps.clock.now().toString().slice(0, 10);
    return ok({
      filename: kind === 'errors' ? `import-errors-${date}.csv` : `import-report-${date}.csv`,
      contentType: 'text/csv; charset=utf-8',
      body:
        kind === 'errors'
          ? errorReportCsv(read.value.rows)
          : fullReportCsv(read.value.job, read.value.rows),
    });
  }
}
