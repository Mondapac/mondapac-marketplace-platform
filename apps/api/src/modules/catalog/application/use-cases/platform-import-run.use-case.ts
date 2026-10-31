import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result, Temporal } from '@mondapac/shared-kernel';
import {
  UseCase,
  type AccessDeclaration,
  type AdminJobContext,
  type JobCallContexts,
  type UseCaseGate,
} from '../../../../platform/authz';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { mapColumns, type ColumnMap } from '../../domain/platform-import/columns';
import { readImportFile, type ParsedRow } from '../../domain/platform-import/import-file';
import {
  type ImportJob,
  type ImportRowRecord,
  type StopReason,
} from '../../domain/platform-import/platform-import-job';
import { checkRow, type CheckEnvironment } from '../../domain/platform-import/row-check';
import { PlatformImportFinished } from '../../domain/events';
import {
  readCheckEnvironment,
  type CheckEnvironmentDependencies,
} from '../platform-import/check-environment';
import type { ImportFileStore } from '../ports/import-file-store';
import type { PlatformImportRepository } from '../ports/platform-import.repository';
import type { ProductRepository } from '../ports/product.repository';
import type { AdminProductPause } from './admin-product-pause.use-case';
import type { PlatformProductCreate } from './platform-product-create.use-case';
import type { PlatformProductSaveDraft } from './platform-product-save-draft.use-case';
import type { PlatformProductSubmit } from './platform-product-submit.use-case';

export interface PlatformImportRunInput {
  /** How long one turn may take (milliseconds). The job's own bound is 10 minutes. */
  readonly budgetMs: number;
}

export type PlatformImportRunOutput =
  | { readonly ran: false }
  | {
      readonly ran: true;
      readonly outcome: 'finished' | 'stopped' | 'queued';
      readonly added: number;
      readonly failed: number;
    };

export type PlatformImportRunFailure = { readonly code: 'access.denied' };

export interface PlatformImportRunDependencies extends CheckEnvironmentDependencies {
  readonly importJobs: PlatformImportRepository;
  readonly importFiles: ImportFileStore;
  readonly products: ProductRepository;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly jobContexts: JobCallContexts;
  readonly platformCreate: PlatformProductCreate;
  readonly platformSaveDraft: PlatformProductSaveDraft;
  readonly platformSubmit: PlatformProductSubmit;
  readonly pause: AdminProductPause;
}

/** How long a runner holds a job before another may take it over (it renews the lease per batch). */
const LEASE_SECONDS = 120;
/** Rows read from the store at a time. */
const BATCH = 20;
/** A wait of this length or shorter is a rate window of a minute: the job waits it out. */
const MAX_WAIT_SECONDS = 120;
/** A transient fault is retried after this long. */
const RETRY_SECONDS = 60;
/** A job that keeps meeting transient faults for this long stops instead (stop reason `unexpected`). */
const GIVE_UP_AFTER_HOURS = 24;

/** What happened to one row. */
type RowOutcome =
  | { readonly kind: 'added'; readonly productId: string; readonly productCode: string }
  | { readonly kind: 'failed'; readonly code: string }
  | { readonly kind: 'wait'; readonly seconds: number }
  | { readonly kind: 'transient' }
  | { readonly kind: 'stop'; readonly reason: StopReason };

/** The use-case failure codes a row may be reported with: codes only, never a message. */
function reasonOf(code: string): string {
  return /^[a-z][a-z0-9_.-]{0,63}$/.test(code) ? code : 'row.failed';
}

/**
 * `platform-import.run` (catalog design 14a; handoff steps 6 and 7): the worker's turn on one
 * confirmed import. Rule `system`, as every job; the work is done **as the admin who started the
 * import**: the job's kept identity (account and session ids) is resumed by `identity` into an
 * authenticated admin actor, only while that person is still an active admin of the Market, and each
 * row then goes through the same use cases the product editor does, so each is gated again by
 * the admin's own permissions (a role taken away stops the next call: `access-lost`).
 *
 * Per row, in file order: the row is **checked again** against the facts of now (a category
 * deactivated since the check fails that row, not the import); then `platform-product.create`,
 * `platform-product.save-draft` (the claim-text control and the attribute schema; a text it
 * refuses fails the row) and `platform-product.submit` (publishes a PLATFORM revision at once);
 * for **Inactive** the product is then paused with `admin-product.pause` (a new PLATFORM product has
 * no Offers, so nothing is on sale in between; a paused product refuses new Offers, 4.1a). Active
 * leaves it published. The import writes no handling, attestation or tag: it has no input for them.
 *
 * A turn ends when the file is done (`finished`), when time is up or a rate window must pass (back
 * to `queued`), or when it cannot go on (`stopped` with a reason; "Retry the rest" resumes it). The
 * product of a row is recorded the moment it exists, so a retry never creates a second one. The
 * finish writes one event, `catalog.platform-import-finished.v1`, for the admins' notice.
 */
export class PlatformImportRun extends UseCase<
  PlatformImportRunInput,
  PlatformImportRunOutput,
  PlatformImportRunFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.platform-import-run',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('PlatformImportRun');

  constructor(
    gate: UseCaseGate,
    private readonly deps: PlatformImportRunDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: PlatformImportRunInput,
  ): Promise<Result<PlatformImportRunOutput, PlatformImportRunFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { deps } = this;
    const { market } = context;
    const startedAt = deps.clock.now();
    const claimed = await this.#write(context, () =>
      deps.importJobs.claim(market, startedAt, startedAt.add({ seconds: LEASE_SECONDS })),
    );
    if (claimed === null) return ok({ ran: false });

    let outcome: PlatformImportRunOutput;
    try {
      outcome = await this.#turn(context, claimed, startedAt.epochMilliseconds + input.budgetMs);
    } catch (error) {
      // An unexpected fault: the job goes back to the queue for another turn, never lost in `running`.
      this.#logger.error({
        msg: 'catalog.platform-import-run',
        code: 'turn-failed',
        reason: error instanceof Error ? error.name : 'unknown',
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      await this.#end(context, claimed, {
        state: 'queued',
        notBefore: deps.clock.now().add({ seconds: RETRY_SECONDS }),
      }).catch(() => undefined);
      return ok({
        ran: true,
        outcome: 'queued',
        added: claimed.addedRows,
        failed: claimed.failedRows,
      });
    }
    this.#logger.log({
      msg: 'catalog.platform-import-run',
      code: outcome.ran ? outcome.outcome : 'idle',
      ...(outcome.ran ? { added: outcome.added, failed: outcome.failed } : {}),
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok(outcome);
  }

  /** One unit with one repository call, for a write that stands alone. */
  async #write<T>(context: CallContext, work: () => Promise<T>): Promise<T> {
    const done = await this.deps.unitOfWork.run(context.market, async () => ok(await work()), {
      timeoutMs: 30_000,
    });
    if (!done.ok) throw new Error('platform-import-run: the unit failed');
    return done.value;
  }

  /** Ends the turn and, for a finish or a stop, writes the event in the same unit. */
  async #end(
    context: CallContext,
    job: ImportJob,
    next:
      | { readonly state: 'queued'; readonly notBefore: Temporal.Instant | null }
      | { readonly state: 'finished' }
      | { readonly state: 'stopped'; readonly reason: StopReason },
  ): Promise<void> {
    const { deps } = this;
    const { market } = context;
    const now = deps.clock.now();
    await this.#write(context, async () => {
      const version = await deps.importJobs.endTurn(
        market,
        job.id,
        next.state === 'finished' ? { state: 'finished', now } : next,
      );
      if (version === null || next.state === 'queued') return;
      // Counts as they stand after the last row of this turn.
      const current = await deps.importJobs.find(market, job.id);
      await deps.outbox.append(context, [
        PlatformImportFinished.record({
          aggregateId: job.id,
          aggregateVersion: version,
          occurredAt: now,
          payload: {
            importId: job.id,
            outcome: next.state === 'finished' ? 'completed' : 'stopped',
            added: current?.addedRows ?? job.addedRows,
            failed: current?.failedRows ?? job.failedRows,
          },
        }),
      ]);
    });
  }

  async #turn(
    context: CallContext,
    job: ImportJob,
    deadlineMs: number,
  ): Promise<PlatformImportRunOutput> {
    const { deps } = this;
    const { market } = context;
    const done = (outcome: 'finished' | 'stopped' | 'queued'): PlatformImportRunOutput => ({
      ran: true,
      outcome,
      added: job.addedRows,
      failed: job.failedRows,
    });
    const stop = async (reason: StopReason): Promise<PlatformImportRunOutput> => {
      await this.#end(context, job, { state: 'stopped', reason });
      return done('stopped');
    };
    const wait = async (seconds: number): Promise<PlatformImportRunOutput> => {
      await this.#end(context, job, {
        state: 'queued',
        notBefore: deps.clock.now().add({ seconds }),
      });
      return done('queued');
    };

    // The admin who started it, if they are still an active admin of this Market.
    const admin = await deps.jobContexts.asAdmin(context, {
      accountId: job.startedByAccountId,
      sessionId: job.startedBySessionId,
    });
    if (admin === null) return stop('access-lost');

    // The file: it must still be the one that was checked.
    let bytes: Buffer | null;
    try {
      bytes = await deps.importFiles.get(job.fileKey);
    } catch {
      return wait(RETRY_SECONDS);
    }
    if (bytes === null || createHash('sha256').update(bytes).digest('hex') !== job.fileSha256) {
      return stop('file-missing');
    }
    const table = readImportFile(bytes);
    if (!table.ok) return stop('file-missing');
    const columns = mapColumns(table.value.header);
    if (!columns.ok) return stop('file-missing');
    const env = await readCheckEnvironment(deps, market);
    if (!env.ok) return wait(RETRY_SECONDS);
    const byNumber = new Map<number, ParsedRow>(
      table.value.rows.map((row) => [row.rowNumber, row]),
    );

    let added = job.addedRows;
    let failed = job.failedRows;
    const startAs = job.startAs ?? 'inactive';
    for (;;) {
      const pending = await this.#write(context, () =>
        deps.importJobs.pendingRows(market, job.id, BATCH),
      );
      if (pending.length === 0) {
        await this.#end(context, job, { state: 'finished' });
        return { ran: true, outcome: 'finished', added, failed };
      }
      if (deps.clock.now().epochMilliseconds >= deadlineMs) {
        await this.#end(context, job, { state: 'queued', notBefore: null });
        return { ran: true, outcome: 'queued', added, failed };
      }
      const leased = await this.#write(context, () =>
        deps.importJobs.renewLease(
          market,
          job.id,
          deps.clock.now().add({ seconds: LEASE_SECONDS }),
        ),
      );
      // Another runner took the job over (our lease had run out): leave it to them.
      if (!leased) return { ran: true, outcome: 'queued', added, failed };

      for (const row of pending) {
        const outcome = await this.#row(
          admin,
          job,
          row,
          byNumber.get(row.rowNumber),
          columns.value.map,
          env.value,
          startAs,
        );
        if (outcome.kind === 'added') {
          await this.#write(context, () =>
            deps.importJobs.settleRow(market, job.id, row.rowNumber, {
              state: 'added',
              productId: outcome.productId,
              productCode: outcome.productCode,
            }),
          );
          added += 1;
        } else if (outcome.kind === 'failed') {
          await this.#write(context, () =>
            deps.importJobs.settleRow(market, job.id, row.rowNumber, {
              state: 'failed',
              code: reasonOf(outcome.code),
            }),
          );
          failed += 1;
        } else if (outcome.kind === 'wait') {
          return outcome.seconds <= MAX_WAIT_SECONDS ? wait(outcome.seconds) : stop('rate-limited');
        } else if (outcome.kind === 'transient') {
          const age = deps.clock.now().epochMilliseconds - (job.startedAt?.epochMilliseconds ?? 0);
          return age > GIVE_UP_AFTER_HOURS * 3_600_000 ? stop('unexpected') : wait(RETRY_SECONDS);
        } else {
          return stop(outcome.reason);
        }
      }
    }
  }

  /** One row: check again, create, save the draft, submit, and for Inactive pause. */
  async #row(
    admin: AdminJobContext,
    job: ImportJob,
    row: ImportRowRecord,
    parsed: ParsedRow | undefined,
    map: ColumnMap,
    env: CheckEnvironment,
    startAs: 'inactive' | 'active',
  ): Promise<RowOutcome> {
    const { deps } = this;
    const { market } = admin;
    if (parsed === undefined) return { kind: 'failed', code: 'row.changed' };
    const checked = checkRow(parsed, map, env);
    if (checked.plan === null) return { kind: 'failed', code: 'row.changed' };

    let productId = row.productId;
    let productCode = row.productCode;
    let variantIds: Id<'Variant'>[];
    let published = false;
    if (productId === null) {
      const created = await deps.platformCreate.execute(admin, { typeCode: checked.plan.typeCode });
      if (!created.ok) return failureOf(created.error.code, created.error);
      productId = created.value.productId;
      productCode = created.value.productCode;
      variantIds = [...created.value.variantIds];
      // Remembered at once: a retry of this row never creates a second product.
      const recorded = { productId, productCode };
      await this.#write(admin, () =>
        deps.importJobs.recordProduct(market, job.id, row.rowNumber, recorded),
      );
    } else {
      // A retry of a row whose product exists: read what it is now.
      const found = await deps.unitOfWork.run(
        market,
        async () => ok(await deps.products.findById(market, productId as Id<'Product'>)),
        { readOnly: true },
      );
      if (!found.ok || found.value === null) return { kind: 'transient' };
      variantIds = found.value.liveVariants.map((variant) => variant.id);
      published = found.value.state.status === 'published';
    }

    if (!published) {
      const saved = await deps.platformSaveDraft.execute(admin, {
        productId,
        content: checked.plan.content,
        variantIds,
      });
      if (!saved.ok) return failureOf(saved.error.code, saved.error);
      if (saved.value.refusedFields.length > 0) {
        return saved.value.refusedFields.some(
          (field) => field.code === 'claim-text.check-unavailable',
        )
          ? { kind: 'transient' }
          : { kind: 'failed', code: 'claim-text.found' };
      }
      const submitted = await deps.platformSubmit.execute(admin, {
        productId,
        replacePending: false,
      });
      if (!submitted.ok) {
        return submitted.error.code === 'claim-text.refused'
          ? { kind: 'failed', code: 'claim-text.found' }
          : failureOf(submitted.error.code, submitted.error);
      }
      if (!submitted.value.published) return { kind: 'failed', code: 'submit.not-published' };
    }

    if (startAs === 'inactive') {
      const paused = await deps.pause.execute(admin, { productId });
      // Already paused (a retry after the pause succeeded) is fine; anything else stops the import.
      if (!paused.ok && paused.error.code !== ('product.already-paused' as string)) {
        return paused.error.code === 'access.unavailable'
          ? { kind: 'transient' }
          : {
              kind: 'stop',
              reason: paused.error.code === 'access.denied' ? 'access-lost' : 'pause-failed',
            };
      }
    }
    return { kind: 'added', productId, productCode: productCode ?? '' };
  }
}

/** Maps a use case's refusal to what the run does about it. */
function failureOf(code: string, detail?: unknown): RowOutcome {
  switch (code) {
    case 'request.throttled':
      return {
        kind: 'wait',
        seconds: Math.max(
          1,
          Number(
            (detail as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds ??
              RETRY_SECONDS,
          ),
        ),
      };
    // The gate refused: the admin lost the permission (or the account) since the start.
    case 'access.denied':
      return { kind: 'stop', reason: 'access-lost' };
    // A store, the matcher or the rate counters could not answer: wait and try the row again.
    case 'access.unavailable':
    case 'conflict.stale':
      return { kind: 'transient' };
    default:
      return { kind: 'failed', code };
  }
}
