import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import {
  UseCase,
  type AccessDeclaration,
  type AuthorisationCheck,
  type UseCaseGate,
} from '../../../../platform/authz';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  CATALOG_PLATFORM_IMPORT_RUN,
  CATALOG_PLATFORM_PRODUCT_EDIT,
  CATALOG_PRODUCT_PAUSE,
} from '../../contracts/permissions';
import { PlatformImportStartedAudit } from '../../domain/audit';
import {
  canConfirm,
  mustSkipErrors,
  rowsToImport,
  START_AS,
  type StartAs,
} from '../../domain/platform-import/platform-import-job';
import { PLATFORM_IMPORT_START_LIMITS } from '../../domain/rate-limits';
import { reserveForAccount, type ReserveFailure } from '../platform-import/reserve';
import { viewOf, type ImportView } from '../platform-import/import-view';
import type { PlatformImportRepository } from '../ports/platform-import.repository';
import type { RateCounterKeys } from '../ports/rate-counter-keys';
import type { RateCounterRepository } from '../ports/rate-counter.repository';
import type { ImportCommonFailure } from '../platform-import/common';
import { EMPTY_PARTS, importIdOf } from '../platform-import/common';

export interface PlatformImportStartInput {
  readonly importId: unknown;
  readonly startAs: unknown;
  readonly skipErrors: unknown;
}

export type PlatformImportStartFailure =
  | ImportCommonFailure
  | ReserveFailure
  | { readonly code: 'import.not-confirmable' }
  | { readonly code: 'import.errors-not-skipped' }
  | { readonly code: 'import.nothing-to-import' }
  | { readonly code: 'import.already-running' }
  | { readonly code: 'import.pause-not-allowed' };

export interface PlatformImportStartDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly importJobs: PlatformImportRepository;
  readonly authorisation: AuthorisationCheck;
  readonly counters: RateCounterRepository;
  readonly counterKeys: RateCounterKeys;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

/**
 * `platform-import.start` (catalog design 14a; handoff step 5, the confirm): the admin who checked a
 * file confirms it, with the status new products start in and whether the rows with errors are
 * left out. Rule: the keys `catalog.platform-import.run` and `catalog.platform-product.edit`. Only
 * the admin who uploaded the file may confirm it (another admin's job is `import.not-found`, the
 * same answer as an unknown id). The job must be `checked` with at least one ready row; a file with
 * errors is confirmed only with `skipErrors: true` (the page's explicit tick); **Inactive** (the
 * default) also needs `catalog.product.pause`, because each product is published and then paused
 * (4.1a), and an import that could not pause would put products live. One import per admin runs
 * at a time, and ten may start a day. The job becomes `queued`, with one audit row, in one unit;
 * the worker takes it from there under the admin's identity.
 */
export class PlatformImportStart extends UseCase<
  PlatformImportStartInput,
  ImportView,
  PlatformImportStartFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.platform-import-start',
    rule: {
      kind: 'permissions',
      allOf: [CATALOG_PLATFORM_IMPORT_RUN.key, CATALOG_PLATFORM_PRODUCT_EDIT.key],
    },
  };

  readonly #logger = new Logger('PlatformImportStart');

  constructor(
    gate: UseCaseGate,
    private readonly deps: PlatformImportStartDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: PlatformImportStartInput,
  ): Promise<Result<ImportView, PlatformImportStartFailure>> {
    const result = await this.#start(context, input);
    this.#logger.log({
      msg: 'catalog.platform-import-start',
      code: result.ok ? 'queued' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #start(
    context: CallContext,
    input: PlatformImportStartInput,
  ): Promise<Result<ImportView, PlatformImportStartFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const fail = (path: string, code: string): Result<never, PlatformImportStartFailure> =>
      err({ code: 'validation.failed', fields: [{ path, code }] });
    if (typeof input !== 'object' || input === null) return fail('body', 'type');
    const id = importIdOf(input.importId);
    if (id === null) return fail('importId', 'format');
    if (!(START_AS as readonly unknown[]).includes(input.startAs)) return fail('startAs', 'enum');
    if (typeof input.skipErrors !== 'boolean') return fail('skipErrors', 'type');
    const startAs = input.startAs as StartAs;
    const skipErrors = input.skipErrors;
    const { deps } = this;

    if (startAs === 'inactive') {
      const decision = await deps.authorisation.check(context, {
        name: 'catalog.platform-import-start-inactive',
        rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_PAUSE.key] },
      });
      if (!decision.allowed) return err({ code: 'import.pause-not-allowed' });
    }
    const throttled = await reserveForAccount(
      deps,
      context,
      PLATFORM_IMPORT_START_LIMITS,
      actor.accountId,
    );
    if (throttled !== null) return err(throttled);

    const now = deps.clock.now();
    const written = await deps.unitOfWork.run<ImportView, PlatformImportStartFailure>(
      market,
      async () => {
        const job = await deps.importJobs.find(market, id);
        // Another admin's job is the same answer as an unknown one.
        if (job === null || job.startedByAccountId !== actor.accountId) {
          return err({ code: 'import.not-found' } as const);
        }
        if (job.state !== 'checked') return err({ code: 'import.not-confirmable' } as const);
        if (!canConfirm(job)) return err({ code: 'import.nothing-to-import' } as const);
        if (mustSkipErrors(job) && !skipErrors) {
          return err({ code: 'import.errors-not-skipped' } as const);
        }
        if (await deps.importJobs.hasActive(market, actor.accountId)) {
          return err({ code: 'import.already-running' } as const);
        }
        const toImport = rowsToImport(job);
        const applied = await deps.importJobs.confirm(market, id, {
          startAs,
          skipErrors,
          toImport,
          now,
        });
        if (!applied) return err({ code: 'import.not-confirmable' } as const);
        await deps.audit.record(
          context,
          PlatformImportStartedAudit.entry(id, {
            before: { state: 'checked' },
            after: {
              state: 'queued',
              startAs,
              skipErrors,
              rows: job.totalRows,
              toImport,
              errorRows: job.errorRows,
            },
          }),
        );
        return ok(
          viewOf(
            {
              ...job,
              state: 'queued',
              startAs,
              skipErrors,
              toImport,
              startedAt: now,
              version: job.version + 1,
            },
            EMPTY_PARTS,
          ),
        );
      },
    );
    if (written.ok) return written;
    return err(written.error);
  }
}
