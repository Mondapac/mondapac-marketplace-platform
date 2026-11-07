import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_IMPORT_RUN, CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import { OwnImportStartedAudit } from '../../domain/audit';
import { canConfirm, mustSkipErrors } from '../../domain/import-jobs/import-job-core';
import {
  SELLER_IMPORT_DAILY_ROWS,
  SELLER_IMPORT_START_LIMITS,
} from '../../domain/rate-limits';
import { isActingAsSession } from '../acting-as';
import { reserveForAccount, type ReserveFailure } from '../platform-import/reserve';
import type { ImportFileStore } from '../ports/import-file-store';
import type { RateCounterKeys } from '../ports/rate-counter-keys';
import type { RateCounterRepository } from '../ports/rate-counter.repository';
import type { SellerEligibilityReader } from '../ports/seller-eligibility.reader';
import type { SellerImportRepository } from '../ports/seller-import.repository';
import {
  dropDiscardedSellerJobs,
  EMPTY_SELLER_PARTS,
  sellerImportIdOf,
  sellerViewOf,
  type SellerImportCommonFailure,
  type SellerImportView,
} from '../seller-import/seller-import-support';

const ACCESS_KEYS = [CATALOG_OWN_IMPORT_RUN.key, CATALOG_OWN_PRODUCT_EDIT.key] as const;

/** The seller and the account of an actor who may use the import; null for any other actor. */
function sellerActor(context: CallContext): {
  readonly sellerId: Id<'Seller'>;
  readonly accountId: Id<'Account'>;
} | null {
  const { actor } = context;
  if (actor.kind !== 'authenticated' || actor.population !== 'seller' || actor.sellerId === null) {
    return null;
  }
  return { sellerId: actor.sellerId, accountId: actor.accountId };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface OwnImportStartInput {
  readonly importId: unknown;
  readonly skipErrors: unknown;
}

export type OwnImportStartFailure =
  | SellerImportCommonFailure
  | ReserveFailure
  | { readonly code: 'seller.not-eligible' }
  | { readonly code: 'import.not-confirmable' }
  | { readonly code: 'import.errors-not-skipped' }
  | { readonly code: 'import.nothing-to-import' }
  | { readonly code: 'import.already-running' }
  | { readonly code: 'import.daily-rows-reached'; readonly retryAfterSeconds: number };

export interface OwnImportStartDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly importJobs: SellerImportRepository;
  readonly eligibility: SellerEligibilityReader;
  readonly counters: RateCounterRepository;
  readonly counterKeys: RateCounterKeys;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

/**
 * `own-import.start` (catalog design 14c): the seller confirms a checked file, choosing whether the
 * rows with errors are left out. Rule: the keys `catalog.own-import.run` and
 * `catalog.own-product.edit`; an acting-as session is refused. Only the account that uploaded the
 * file may confirm it; another seller's job and an unknown id answer the same `import.not-found`.
 * Five imports start a seller a day; one runs at a time; at most 10,000 rows start in 24 hours
 * across imports. The job becomes `queued` with one audit row, in one unit; the worker takes it from
 * there under the seller's identity.
 */
export class OwnImportStart extends UseCase<
  OwnImportStartInput,
  SellerImportView,
  OwnImportStartFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-import-start',
    rule: { kind: 'permissions', allOf: ACCESS_KEYS },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('OwnImportStart');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnImportStartDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnImportStartInput,
  ): Promise<Result<SellerImportView, OwnImportStartFailure>> {
    const result = await this.#start(context, input);
    this.#logger.log({
      msg: 'catalog.own-import-start',
      code: result.ok ? 'queued' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #start(
    context: CallContext,
    input: OwnImportStartInput,
  ): Promise<Result<SellerImportView, OwnImportStartFailure>> {
    const { market } = context;
    const who = sellerActor(context);
    if (who === null) return err({ code: 'access.denied' });
    if (isActingAsSession(context.actor)) return err({ code: 'access.acting-as-refused' });
    const fail = (path: string, code: string): Result<never, OwnImportStartFailure> =>
      err({ code: 'validation.failed', fields: [{ path, code }] });
    if (typeof input !== 'object' || input === null) return fail('body', 'type');
    const id = sellerImportIdOf(input.importId);
    if (id === null) return fail('importId', 'format');
    if (typeof input.skipErrors !== 'boolean') return fail('skipErrors', 'type');
    const skipErrors = input.skipErrors;
    const { deps } = this;
    if (!(await deps.eligibility.isEligible(context, who.sellerId))) {
      return err({ code: 'seller.not-eligible' });
    }
    const throttled = await reserveForAccount(
      deps,
      context,
      SELLER_IMPORT_START_LIMITS,
      who.sellerId,
    );
    if (throttled !== null) return err(throttled);

    const now = deps.clock.now();
    const written = await deps.unitOfWork.run<SellerImportView, OwnImportStartFailure>(
      market,
      async () => {
        const job = await deps.importJobs.find(market, who.sellerId, id);
        // Another seller's job, and another account's, is the same answer as an unknown one.
        if (job === null || job.startedByAccountId !== who.accountId) {
          return err({ code: 'import.not-found' } as const);
        }
        if (job.state !== 'checked') return err({ code: 'import.not-confirmable' } as const);
        if (!canConfirm(job)) return err({ code: 'import.nothing-to-import' } as const);
        if (mustSkipErrors(job) && !skipErrors) {
          return err({ code: 'import.errors-not-skipped' } as const);
        }
        if (await deps.importJobs.hasActive(market, who.sellerId)) {
          return err({ code: 'import.already-running' } as const);
        }
        const toImport = job.readyRows;
        const since = now.subtract({ milliseconds: DAY_MS });
        const started = await deps.importJobs.rowsStartedSince(market, who.sellerId, since);
        if (started + toImport > SELLER_IMPORT_DAILY_ROWS) {
          return err({ code: 'import.daily-rows-reached', retryAfterSeconds: 3600 } as const);
        }
        const applied = await deps.importJobs.confirm(market, id, { skipErrors, toImport, now });
        if (!applied) return err({ code: 'import.not-confirmable' } as const);
        await deps.audit.record(
          context,
          OwnImportStartedAudit.entry(id, {
            before: { state: 'checked' },
            after: {
              state: 'queued',
              mode: job.mode,
              skipErrors,
              rows: job.totalRows,
              toImport,
              errorRows: job.errorRows,
            },
          }),
        );
        return ok(
          sellerViewOf(
            {
              ...job,
              state: 'queued',
              skipErrors,
              toImport,
              startedAt: now,
              version: job.version + 1,
            },
            EMPTY_SELLER_PARTS,
            now,
          ),
        );
      },
    );
    return written.ok ? written : err(written.error);
  }
}

export type OwnImportResumeFailure =
  | SellerImportCommonFailure
  | { readonly code: 'seller.not-eligible' }
  | { readonly code: 'import.not-resumable' }
  | { readonly code: 'import.already-running' };

export interface OwnImportResumeDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly importJobs: SellerImportRepository;
  readonly eligibility: SellerEligibilityReader;
  readonly clock: Clock;
}

/**
 * `own-import.resume` (design 14c): the seller who started a stopped import runs the rest of its rows
 * again, while its file is still stored. A seller who can no longer sell is `seller.not-eligible`.
 */
export class OwnImportResume extends UseCase<
  { readonly importId: unknown },
  SellerImportView,
  OwnImportResumeFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-import-resume',
    rule: { kind: 'permissions', allOf: ACCESS_KEYS },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnImportResumeDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly importId: unknown },
  ): Promise<Result<SellerImportView, OwnImportResumeFailure>> {
    const { market } = context;
    const who = sellerActor(context);
    if (who === null) return err({ code: 'access.denied' });
    if (isActingAsSession(context.actor)) return err({ code: 'access.acting-as-refused' });
    const id = sellerImportIdOf(input?.importId);
    if (id === null) {
      return err({ code: 'validation.failed', fields: [{ path: 'importId', code: 'format' }] });
    }
    const { deps } = this;
    if (!(await deps.eligibility.isEligible(context, who.sellerId))) {
      return err({ code: 'seller.not-eligible' });
    }
    const now = deps.clock.now();
    const written = await deps.unitOfWork.run<SellerImportView, OwnImportResumeFailure>(
      market,
      async () => {
        const job = await deps.importJobs.find(market, who.sellerId, id);
        if (job === null || job.startedByAccountId !== who.accountId) {
          return err({ code: 'import.not-found' } as const);
        }
        if (job.state !== 'stopped' || job.fileDeletedAt !== null) {
          return err({ code: 'import.not-resumable' } as const);
        }
        if (await deps.importJobs.hasActive(market, who.sellerId)) {
          return err({ code: 'import.already-running' } as const);
        }
        if (!(await deps.importJobs.resume(market, id))) {
          return err({ code: 'import.not-resumable' } as const);
        }
        return ok(
          sellerViewOf(
            { ...job, state: 'queued', stopReason: null, finishedAt: null, version: job.version + 1 },
            EMPTY_SELLER_PARTS,
            now,
          ),
        );
      },
    );
    return written.ok ? written : err(written.error);
  }
}

export type OwnImportDiscardFailure =
  SellerImportCommonFailure | { readonly code: 'import.not-discardable' };

export interface OwnImportDiscardDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly importJobs: SellerImportRepository;
  readonly importFiles: ImportFileStore;
  readonly clock: Clock;
}

/**
 * `own-import.discard` (design 14c): the seller who uploaded a checked file drops it: the job
 * becomes `discarded`, its file is deleted and then the job and its rows. Only a `checked` job; an
 * import that was confirmed keeps running.
 */
export class OwnImportDiscard extends UseCase<
  { readonly importId: unknown },
  { readonly discarded: true },
  OwnImportDiscardFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-import-discard',
    rule: { kind: 'permissions', allOf: ACCESS_KEYS },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnImportDiscardDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly importId: unknown },
  ): Promise<Result<{ readonly discarded: true }, OwnImportDiscardFailure>> {
    const { market } = context;
    const who = sellerActor(context);
    if (who === null) return err({ code: 'access.denied' });
    if (isActingAsSession(context.actor)) return err({ code: 'access.acting-as-refused' });
    const id = sellerImportIdOf(input?.importId);
    if (id === null) {
      return err({ code: 'validation.failed', fields: [{ path: 'importId', code: 'format' }] });
    }
    const { deps } = this;
    const now = deps.clock.now();
    const done = await deps.unitOfWork.run<{ readonly fileKey: string }, OwnImportDiscardFailure>(
      market,
      async () => {
        const job = await deps.importJobs.find(market, who.sellerId, id);
        if (job === null || job.startedByAccountId !== who.accountId) {
          return err({ code: 'import.not-found' } as const);
        }
        const dropped = await deps.importJobs.discard(market, id, now);
        if (dropped === null) return err({ code: 'import.not-discardable' } as const);
        return ok(dropped);
      },
    );
    if (!done.ok) return err(done.error);
    await dropDiscardedSellerJobs(deps, market, [{ id, fileKey: done.value.fileKey }], now);
    return ok({ discarded: true });
  }
}
