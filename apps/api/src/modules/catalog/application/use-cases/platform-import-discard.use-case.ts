import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PLATFORM_IMPORT_RUN } from '../../contracts/permissions';
import type { ImportFileStore } from '../ports/import-file-store';
import type { PlatformImportRepository } from '../ports/platform-import.repository';
import type { ImportCommonFailure } from '../platform-import/common';
import { dropDiscardedJobs, importIdOf } from '../platform-import/common';

export interface PlatformImportDiscardDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly importJobs: PlatformImportRepository;
  readonly importFiles: ImportFileStore;
  readonly clock: Clock;
}

/**
 * `platform-import.discard` (design 14a; the **Cancel** of the page's first two steps): the admin
 * who uploaded a checked file drops it. The job becomes `discarded`, its file is deleted and then
 * the job and its rows (data design 3.29: a discarded check is not kept for 90 days). Only a
 * `checked` job: an import that was confirmed keeps running (the page's "You can leave this page");
 * a job of another admin is `import.not-found`. Rule: the key `catalog.platform-import.run`.
 */
export class PlatformImportDiscard extends UseCase<
  { readonly importId: unknown },
  { readonly discarded: true },
  ImportCommonFailure | { readonly code: 'import.not-discardable' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.platform-import-discard',
    rule: { kind: 'permissions', allOf: [CATALOG_PLATFORM_IMPORT_RUN.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PlatformImportDiscardDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly importId: unknown },
  ): Promise<
    Result<
      { readonly discarded: true },
      ImportCommonFailure | { readonly code: 'import.not-discardable' }
    >
  > {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const id = importIdOf(input?.importId);
    if (id === null) {
      return err({ code: 'validation.failed', fields: [{ path: 'importId', code: 'format' }] });
    }
    const { deps } = this;
    const now = deps.clock.now();
    const done = await deps.unitOfWork.run<
      { readonly fileKey: string },
      ImportCommonFailure | { readonly code: 'import.not-discardable' }
    >(market, async () => {
      const job = await deps.importJobs.find(market, id);
      if (job === null || job.startedByAccountId !== actor.accountId) {
        return err({ code: 'import.not-found' } as const);
      }
      const dropped = await deps.importJobs.discard(market, id, now);
      if (dropped === null) return err({ code: 'import.not-discardable' } as const);
      return ok(dropped);
    });
    if (!done.ok) return err(done.error);
    // After the unit: the file goes and, with it, the job and its rows (nobody reads a discarded
    // check again). What stays after a failure is deleted by the purge job.
    await dropDiscardedJobs(deps, market, [{ id, fileKey: done.value.fileKey }], now);
    return ok({ discarded: true });
  }
}
