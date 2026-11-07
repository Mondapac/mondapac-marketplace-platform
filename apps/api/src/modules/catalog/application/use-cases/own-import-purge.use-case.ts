import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { ImportFileStore } from '../ports/import-file-store';
import type { SellerImportRepository } from '../ports/seller-import.repository';

import {
  IMPORT_FILE_RETENTION_DAYS,
  IMPORT_JOB_RETENTION_DAYS,
  PURGE_BATCH,
  PURGE_BUDGET_MS,
} from './platform-import-purge.use-case';

const BATCH = PURGE_BATCH;
const BUDGET_MS = PURGE_BUDGET_MS;

export interface OwnImportPurgeOutput {
  readonly filesDeleted: number;
  readonly jobsDeleted: number;
}

export interface OwnImportPurgeDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly importJobs: SellerImportRepository;
  readonly importFiles: ImportFileStore;
  readonly clock: Clock;
}

/**
 * `catalog.purge-seller-imports` (catalog design 10.4, 14a; ADR-0016): uploaded files go to
 * object storage and are **deleted after the retention**, 7 days after their check (never while the
 * import is queued or running; a discarded one at once), a discarded or never confirmed check
 * together with its rows as soon as its file is gone, and the record and report of a finished or
 * stopped import 90 days after it was created. The file is deleted first and the job row marked, so
 * a job is deleted only without a stored file; a failed delete leaves the row for the next run.
 * Work goes in units of 5 jobs, looped within a time budget. Rule `system`; safe to run twice and
 * concurrently.
 */
export class OwnImportPurge extends UseCase<
  Record<string, never>,
  OwnImportPurgeOutput,
  { readonly code: 'access.denied' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-import-purge',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('OwnImportPurge');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnImportPurgeDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<OwnImportPurgeOutput, { readonly code: 'access.denied' }>> {
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
      msg: 'catalog.own-import-purge',
      filesDeleted,
      jobsDeleted,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok({ filesDeleted, jobsDeleted });
  }
}
