import { ok, parseId } from '@mondapac/shared-kernel';
import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { ImportFileStore } from '../ports/import-file-store';
import type { PlatformImportRepository } from '../ports/platform-import.repository';

// What the platform import use cases share (catalog design 14a).

export type ImportCommonFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'import.not-found' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export const importIdOf = (value: unknown): Id<'PlatformImport'> | null => {
  if (typeof value !== 'string') return null;
  const parsed = parseId<'PlatformImport'>(value);
  return parsed.ok ? parsed.value : null;
};

export const EMPTY_PARTS = { errorRows: [], failedRows: [], previewRows: [] } as const;

/**
 * A discarded job is never read again, so it does not wait for the 90-day retention (data design
 * 3.29, 10.3): once its file is gone, the job and its rows are deleted, in a unit of their own.
 * Called after the unit that discarded it. A failure here only leaves the job to the purge job,
 * which deletes a discarded job as soon as its file is gone.
 */
export async function dropDiscardedJobs(
  deps: {
    readonly unitOfWork: UnitOfWork;
    readonly importJobs: PlatformImportRepository;
    readonly importFiles: ImportFileStore;
  },
  market: MarketContext,
  jobs: readonly { readonly id: Id<'PlatformImport'>; readonly fileKey: string }[],
  now: Temporal.Instant,
): Promise<void> {
  for (const job of jobs) {
    try {
      await deps.importFiles.delete(job.fileKey);
      await deps.unitOfWork.run(market, async () => {
        await deps.importJobs.markFileDeleted(market, job.id, now);
        await deps.importJobs.deleteDiscarded(market, { ids: [job.id] });
        return ok(undefined);
      });
    } catch {
      // The row and the file stay for the purge job.
    }
  }
}
