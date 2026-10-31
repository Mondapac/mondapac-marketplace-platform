import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { ImportFileStore } from '../ports/import-file-store';
import type { PlatformImportRepository } from '../ports/platform-import.repository';

/** Uploaded files are kept this long after their check (retention, design 10.4); a stopped import resumes within it. */
export const IMPORT_FILE_RETENTION_DAYS = 7;
/** A job's record and report are kept this long after it was created. */
export const IMPORT_JOB_RETENTION_DAYS = 90;
const BATCH = 100;

export interface PlatformImportPurgeOutput {
  readonly filesDeleted: number;
  readonly jobsDeleted: number;
}

export interface PlatformImportPurgeDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly importJobs: PlatformImportRepository;
  readonly importFiles: ImportFileStore;
  readonly clock: Clock;
}

/**
 * `catalog.purge-platform-imports` (catalog design 10.4, 14a; ADR-0016): uploaded files go to
 * object storage and are **deleted after the retention**, 7 days after their check (never while the
 * import is queued or running), and an import's record and report 90 days after it was created. The
 * file is deleted first and the job row marked, so a job is deleted only without a stored file; a
 * failed delete leaves the row for the next run. Rule `system`; safe to run twice and concurrently.
 */
export class PlatformImportPurge extends UseCase<
  Record<string, never>,
  PlatformImportPurgeOutput,
  { readonly code: 'access.denied' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.platform-import-purge',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('PlatformImportPurge');

  constructor(
    gate: UseCaseGate,
    private readonly deps: PlatformImportPurgeDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<PlatformImportPurgeOutput, { readonly code: 'access.denied' }>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { market } = context;
    const { deps } = this;
    const now = deps.clock.now();

    const due = await deps.unitOfWork.run(
      market,
      async () =>
        ok(
          await deps.importJobs.filesDue(
            market,
            now.subtract({ hours: IMPORT_FILE_RETENTION_DAYS * 24 }),
            BATCH,
          ),
        ),
      { readOnly: true },
    );
    let filesDeleted = 0;
    if (due.ok) {
      for (const job of due.value) {
        try {
          await deps.importFiles.delete(job.fileKey);
          await deps.unitOfWork.run(market, async () => {
            await deps.importJobs.markFileDeleted(market, job.id, now);
            return ok(undefined);
          });
          filesDeleted += 1;
        } catch {
          // The row stays, the next run tries again.
        }
      }
    }
    const jobs = await deps.unitOfWork.run(market, async () =>
      ok(
        await deps.importJobs.deleteSettledBefore(
          market,
          now.subtract({ hours: IMPORT_JOB_RETENTION_DAYS * 24 }),
          BATCH,
        ),
      ),
    );
    const jobsDeleted = jobs.ok ? jobs.value : 0;
    this.#logger.log({
      msg: 'catalog.platform-import-purge',
      filesDeleted,
      jobsDeleted,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok({ filesDeleted, jobsDeleted });
  }
}
