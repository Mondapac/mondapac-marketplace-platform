import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { ImportFileStore } from '../ports/import-file-store';
import type { PlatformImportRepository } from '../ports/platform-import.repository';

/** Uploaded files are kept this long after their check (retention, design 10.4); a stopped import resumes within it. */
export const IMPORT_FILE_RETENTION_DAYS = 7;
/**
 * A finished or stopped job's record and report are kept this long after it was created. A
 * discarded or never confirmed check is not kept: it is deleted as soon as its file is gone.
 */
export const IMPORT_JOB_RETENTION_DAYS = 90;
/** Jobs per unit: at most 5 x 5,000 rows leave in one transaction. */
export const PURGE_BATCH = 5;
const BATCH = PURGE_BATCH;
/** One run loops over its batches for this long at most; the job runs again the next hour. */
export const PURGE_BUDGET_MS = 30_000;
const BUDGET_MS = PURGE_BUDGET_MS;

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
 * import is queued or running; a discarded one at once), a discarded or never confirmed check
 * together with its rows as soon as its file is gone, and the record and report of a finished or
 * stopped import 90 days after it was created. The file is deleted first and the job row marked, so
 * a job is deleted only without a stored file; a failed delete leaves the row for the next run.
 * Work goes in units of 5 jobs, looped within a time budget. Rule `system`; safe to run twice and
 * concurrently.
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

    const started = now.epochMilliseconds;
    const overBudget = (): boolean => deps.clock.now().epochMilliseconds - started >= BUDGET_MS;

    // Small units, looped within the time budget: a job holds up to 5,000 rows, so one unit never
    // reaches more than BATCH x 5,000 rows (data design 10.3).
    let filesDeleted = 0;
    while (!overBudget()) {
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
      if (!due.ok || due.value.length === 0) break;
      let deletedHere = 0;
      for (const job of due.value) {
        try {
          await deps.importFiles.delete(job.fileKey);
          await deps.unitOfWork.run(market, async () => {
            await deps.importJobs.markFileDeleted(market, job.id, now);
            return ok(undefined);
          });
          deletedHere += 1;
        } catch {
          // The row stays, the next run tries again.
        }
      }
      filesDeleted += deletedHere;
      // Nothing went: the same rows would come back, so stop and leave them to the next run.
      if (deletedHere === 0 || due.value.length < BATCH) break;
    }

    // Discarded checks go as soon as their file is gone; finished and stopped imports after 90 days.
    let jobsDeleted = 0;
    const settledBefore = now.subtract({ hours: IMPORT_JOB_RETENTION_DAYS * 24 });
    for (const next of [
      () => deps.importJobs.deleteDiscarded(market, { limit: BATCH }),
      () => deps.importJobs.deleteSettledBefore(market, settledBefore, BATCH),
    ]) {
      while (!overBudget()) {
        const deleted = await deps.unitOfWork.run(market, async () => ok(await next()));
        if (!deleted.ok || deleted.value === 0) break;
        jobsDeleted += deleted.value;
        if (deleted.value < BATCH) break;
      }
    }
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
