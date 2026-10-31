import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PLATFORM_IMPORT_RUN } from '../../contracts/permissions';
import type { ImportJob } from '../../domain/platform-import/platform-import-job';
import {
  viewOf,
  VIEW_ERROR_LINES,
  VIEW_FAILURE_LINES,
  VIEW_PREVIEW_ROWS,
  type ImportView,
} from '../platform-import/import-view';
import type { PlatformImportRepository } from '../ports/platform-import.repository';
import type { ImportCommonFailure } from '../platform-import/common';
import { importIdOf } from '../platform-import/common';

export interface PlatformImportReadDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly importJobs: PlatformImportRepository;
}

/** The parts of a job's view that its state needs: errors at the check, failures after a run, a preview for a ready file. */
async function loadView(
  repository: PlatformImportRepository,
  market: CallContext['market'],
  job: ImportJob,
): Promise<ImportView> {
  const checking = job.state === 'checked';
  const ran = job.state === 'finished' || job.state === 'stopped';
  const [errorRows, failedRows, previewRows] = await Promise.all([
    checking && job.errorRows > 0
      ? repository.rows(
          market,
          job.id,
          { checkState: 'error' },
          { offset: 0, limit: VIEW_ERROR_LINES },
        )
      : [],
    ran && job.failedRows > 0
      ? repository.rows(
          market,
          job.id,
          { runState: 'failed' },
          { offset: 0, limit: VIEW_FAILURE_LINES },
        )
      : [],
    checking
      ? repository.rows(
          market,
          job.id,
          { checkState: 'ready' },
          { offset: 0, limit: VIEW_PREVIEW_ROWS },
        )
      : [],
  ]);
  return viewOf(job, { errorRows, failedRows, previewRows });
}

export interface PlatformImportReadInput {
  /** The import to read, or null for the admin's latest (what the page opens on). */
  readonly importId: unknown;
}

/**
 * `platform-import.read` (catalog design 14a): the state of an import for the page: counts, the
 * error lines of a check, the failures of a run, the progress of a running one. Rule: the key
 * `catalog.platform-import.run`. Any admin who holds it may read any import of the Market (the
 * content is platform products, and the finished notice goes to all of them); another Market's id
 * and an unknown one are the same `import.not-found`. With no id it answers the admin's own latest
 * import, or `null`.
 */
export class PlatformImportRead extends UseCase<
  PlatformImportReadInput,
  ImportView | null,
  ImportCommonFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.platform-import-read',
    rule: { kind: 'permissions', allOf: [CATALOG_PLATFORM_IMPORT_RUN.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PlatformImportReadDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: PlatformImportReadInput,
  ): Promise<Result<ImportView | null, ImportCommonFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const wanted = input?.importId ?? null;
    const id = wanted === null ? null : importIdOf(wanted);
    if (wanted !== null && id === null) {
      return err({ code: 'validation.failed', fields: [{ path: 'importId', code: 'format' }] });
    }
    const { importJobs } = this.deps;
    const read = await this.deps.unitOfWork.run<ImportView | null, ImportCommonFailure>(
      market,
      async () => {
        const job =
          id === null
            ? await importJobs.latestOf(market, actor.accountId)
            : await importJobs.find(market, id);
        if (job === null) {
          return id === null ? ok(null) : err({ code: 'import.not-found' } as const);
        }
        return ok(await loadView(importJobs, market, job));
      },
      { readOnly: true },
    );
    if (!read.ok)
      return read.error.code === 'import.not-found' ? read : err({ code: 'access.unavailable' });
    return read;
  }
}
