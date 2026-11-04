import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  CATALOG_PLATFORM_IMPORT_RUN,
  CATALOG_PLATFORM_PRODUCT_EDIT,
} from '../../contracts/permissions';
import { viewOf, type ImportView } from '../platform-import/import-view';
import type { PlatformImportRepository } from '../ports/platform-import.repository';
import type { ImportCommonFailure } from '../platform-import/common';
import { EMPTY_PARTS, importIdOf } from '../platform-import/common';

export interface PlatformImportResumeDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly importJobs: PlatformImportRepository;
  readonly clock: Clock;
}

/**
 * `platform-import.resume` (design 14a; "Retry the rest" of a run that stopped part way): the admin
 * who started the import asks the worker to go on with the rows it did not try. The products
 * already added are kept and never added twice; failed rows stay failed with their reasons. Only a
 * `stopped` job whose file is still stored; one import per admin runs at a time. Rule: the keys
 * `catalog.platform-import.run` and `catalog.platform-product.edit`.
 */
export class PlatformImportResume extends UseCase<
  { readonly importId: unknown },
  ImportView,
  | ImportCommonFailure
  | { readonly code: 'import.not-resumable' }
  | { readonly code: 'import.already-running' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.platform-import-resume',
    rule: {
      kind: 'permissions',
      allOf: [CATALOG_PLATFORM_IMPORT_RUN.key, CATALOG_PLATFORM_PRODUCT_EDIT.key],
    },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PlatformImportResumeDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly importId: unknown },
  ): Promise<
    Result<
      ImportView,
      | ImportCommonFailure
      | { readonly code: 'import.not-resumable' }
      | { readonly code: 'import.already-running' }
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
    const written = await deps.unitOfWork.run<
      ImportView,
      | ImportCommonFailure
      | { readonly code: 'import.not-resumable' }
      | { readonly code: 'import.already-running' }
    >(market, async () => {
      const job = await deps.importJobs.find(market, id);
      if (job === null || job.startedByAccountId !== actor.accountId) {
        return err({ code: 'import.not-found' } as const);
      }
      if (job.state !== 'stopped' || job.fileDeletedAt !== null) {
        return err({ code: 'import.not-resumable' } as const);
      }
      if (await deps.importJobs.hasActive(market, actor.accountId)) {
        return err({ code: 'import.already-running' } as const);
      }
      if (!(await deps.importJobs.resume(market, id))) {
        return err({ code: 'import.not-resumable' } as const);
      }
      return ok(
        viewOf(
          { ...job, state: 'queued', stopReason: null, version: job.version + 1 },
          EMPTY_PARTS,
        ),
      );
    });
    return written.ok ? written : err(written.error);
  }
}
