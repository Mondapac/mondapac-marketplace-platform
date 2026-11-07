import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result, Temporal } from '@mondapac/shared-kernel';
import {
  UseCase,
  type AccessDeclaration,
  type JobCallContexts,
  type SellerJobContext,
  type UseCaseGate,
} from '../../../../platform/authz';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { SellerImportFinished } from '../../domain/events';
import { readImportFile } from '../../domain/platform-import/import-file';
import { IMPORT_LIMITS } from '../../domain/platform-import/limits';
import { mapSellerColumns, type SellerColumnMap } from '../../domain/seller-import/columns';
import {
  attributeColumnCodes,
  checkSellerGroup,
  groupSellerRows,
  optionColumnCodes,
  type SellerCheckEnvironment,
  type SellerCheckFacts,
  type SellerGroupPlan,
  type SellerGroupRows,
} from '../../domain/seller-import/row-check';
import type {
  SellerImportJob,
  SellerRowRecord,
  SellerStopReason,
} from '../../domain/seller-import/seller-import-job';
import {
  BATCH,
  failureActionOf,
  GIVE_UP_AFTER_HOURS,
  LEASE_SECONDS,
  MAX_WAIT_SECONDS,
  reasonOf,
  RETRY_SECONDS,
} from '../import-jobs/run-policy';
import type { CheckEnvironmentDependencies } from '../platform-import/check-environment';
import type { AllowedProductTypesReader } from '../ports/allowed-product-types.reader';
import type { ImportFileParsers } from '../ports/import-file-parsers';
import type { ImportFileStore } from '../ports/import-file-store';
import type { OfferRepository } from '../ports/offer.repository';
import type { SellerEligibilityReader } from '../ports/seller-eligibility.reader';
import type { SellerImportFactsReader } from '../ports/seller-import-facts.reader';
import type { SellerImportRepository } from '../ports/seller-import.repository';
import { readSellerCheckEnvironment } from '../seller-import/seller-import-support';
import type {
  OwnImportRowOfferCreate,
  OwnImportRowOfferEdit,
  OwnImportRowCreate,
  OwnImportRowSave,
} from './own-import-row.use-case';

export interface OwnImportRunInput {
  /** How long one turn may take (milliseconds). */
  readonly budgetMs: number;
}

export type OwnImportRunOutput =
  | { readonly ran: false }
  | {
      readonly ran: true;
      readonly outcome: 'finished' | 'stopped' | 'queued';
      readonly created: number;
      readonly updated: number;
      readonly failed: number;
    };

export type OwnImportRunFailure = { readonly code: 'access.denied' };

export interface OwnImportRunDependencies extends CheckEnvironmentDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly sellerJobs: SellerImportRepository;
  readonly importFiles: ImportFileStore;
  readonly importParsers: ImportFileParsers;
  readonly importFacts: SellerImportFactsReader;
  readonly eligibility: SellerEligibilityReader;
  readonly allowedTypes: AllowedProductTypesReader;
  readonly offers: OfferRepository;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly jobContexts: JobCallContexts;
  readonly ownRowCreate: OwnImportRowCreate;
  readonly ownRowSave: OwnImportRowSave;
  readonly ownRowOfferCreate: OwnImportRowOfferCreate;
  readonly ownRowOfferEdit: OwnImportRowOfferEdit;
}

/** What happened to one group. */
type GroupOutcome =
  | { readonly kind: 'done'; readonly state: 'created' | 'updated' | 'unchanged' }
  | { readonly kind: 'failed'; readonly code: string }
  | { readonly kind: 'wait'; readonly seconds: number }
  | { readonly kind: 'transient' }
  | { readonly kind: 'ineligible' }
  | { readonly kind: 'stop'; readonly reason: SellerStopReason };

interface Ids {
  productId: string | null;
  offerId: string | null;
  productCode: string | null;
}

/**
 * `own-import.run` (catalog design 14c): the worker's turn on one confirmed seller import. Rule
 * `system`, as every job; the work is done **as the seller account that started the import**: the
 * job's kept identity (account, session and seller ids) is resumed by `identity` into an
 * authenticated seller actor, only while that person is still an active member of that seller and
 * the session is not an acting-as one, and each group then goes through the row use cases, each gated
 * again by the seller's own keys (a key taken away stops the next call: `access-lost`).
 *
 * Per group, in file order and never split across a batch: the group is **checked again** against
 * the facts of now (a category retired since the check fails that group, not the import); a
 * `my-products` create makes the product with its Offer (`own-import.row-create`), remembers both ids
 * at once so a retry never creates a second one, and saves the draft (`own-import.row-save`); an
 * update saves the draft over the stored one and edits the Offer. A `sell-from-catalogue` row makes
 * or edits an Offer on the catalogue product. **Nothing is submitted, published or tagged**: the
 * import has no input for a certification, handling, attestation, status, price, cost or stock.
 * A seller who can no longer sell fails the rest of the rows and stops the job
 * (`seller-not-eligible`).
 *
 * A turn ends when the file is done (`finished`), when time is up or a rate window must pass (back
 * to `queued`), or when it cannot go on (`stopped` with a reason). The finish writes one event,
 * `catalog.seller-import-finished.v1`, for the seller's notice.
 */
export class OwnImportRun extends UseCase<OwnImportRunInput, OwnImportRunOutput, OwnImportRunFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-import-run',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('OwnImportRun');

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnImportRunDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnImportRunInput,
  ): Promise<Result<OwnImportRunOutput, OwnImportRunFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { deps } = this;
    const { market } = context;
    const startedAt = deps.clock.now();
    const claimed = await this.#write(context, () =>
      deps.sellerJobs.claim(market, startedAt, startedAt.add({ seconds: LEASE_SECONDS })),
    );
    if (claimed === null) return ok({ ran: false });

    let outcome: OwnImportRunOutput;
    try {
      outcome = await this.#turn(context, claimed, startedAt.epochMilliseconds + input.budgetMs);
    } catch (error) {
      // An unexpected fault: the job goes back to the queue for another turn, never lost in `running`.
      this.#logger.error({
        msg: 'catalog.own-import-run',
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
        created: claimed.createdRows,
        updated: claimed.updatedRows,
        failed: claimed.failedRows,
      });
    }
    this.#logger.log({
      msg: 'catalog.own-import-run',
      code: outcome.ran ? outcome.outcome : 'idle',
      ...(outcome.ran
        ? { created: outcome.created, updated: outcome.updated, failed: outcome.failed }
        : {}),
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok(outcome);
  }

  async #write<T>(context: CallContext, work: () => Promise<T>): Promise<T> {
    const done = await this.deps.unitOfWork.run(context.market, async () => ok(await work()), {
      timeoutMs: 30_000,
    });
    if (!done.ok) throw new Error('own-import-run: the unit failed');
    return done.value;
  }

  /** Ends the turn and, for a finish or a stop, writes the event in the same unit. */
  async #end(
    context: CallContext,
    job: SellerImportJob,
    next:
      | { readonly state: 'queued'; readonly notBefore: Temporal.Instant | null }
      | { readonly state: 'finished' }
      | { readonly state: 'stopped'; readonly reason: SellerStopReason },
  ): Promise<void> {
    const { deps } = this;
    const { market } = context;
    const now = deps.clock.now();
    await this.#write(context, async () => {
      const version = await deps.sellerJobs.endTurn(
        market,
        job.id,
        next.state === 'finished' ? { state: 'finished', now } : next,
      );
      if (version === null || next.state === 'queued') return;
      const current = await deps.sellerJobs.find(market, job.sellerId, job.id);
      await deps.outbox.append(context, [
        SellerImportFinished.record({
          aggregateId: job.id,
          aggregateVersion: version,
          occurredAt: now,
          payload: {
            importId: job.id,
            sellerId: job.sellerId,
            outcome: next.state === 'finished' ? 'completed' : 'stopped',
            created: current?.createdRows ?? job.createdRows,
            updated: current?.updatedRows ?? job.updatedRows,
            failed: current?.failedRows ?? job.failedRows,
          },
        }),
      ]);
    });
  }

  async #turn(
    context: CallContext,
    job: SellerImportJob,
    deadlineMs: number,
  ): Promise<OwnImportRunOutput> {
    const { deps } = this;
    const { market } = context;
    const counts = async (): Promise<{ created: number; updated: number; failed: number }> => {
      const current = await this.#write(context, () =>
        deps.sellerJobs.find(market, job.sellerId, job.id),
      );
      return {
        created: current?.createdRows ?? job.createdRows,
        updated: current?.updatedRows ?? job.updatedRows,
        failed: current?.failedRows ?? job.failedRows,
      };
    };
    const done = async (outcome: 'finished' | 'stopped' | 'queued'): Promise<OwnImportRunOutput> => ({
      ran: true,
      outcome,
      ...(await counts()),
    });
    const stop = async (reason: SellerStopReason): Promise<OwnImportRunOutput> => {
      await this.#end(context, job, { state: 'stopped', reason });
      return done('stopped');
    };
    const wait = async (seconds: number): Promise<OwnImportRunOutput> => {
      await this.#end(context, job, {
        state: 'queued',
        notBefore: deps.clock.now().add({ seconds }),
      });
      return done('queued');
    };

    // The seller account that started it, if it is still an active member of that seller.
    const seller = await deps.jobContexts.asSeller(context, {
      accountId: job.startedByAccountId,
      sessionId: job.startedBySessionId,
      sellerId: job.sellerId,
    });
    if (seller === null) return stop('access-lost');

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
    const table = await readImportFile(bytes, IMPORT_LIMITS, deps.importParsers);
    if (!table.ok) return stop('file-missing');

    const allowed = await deps.allowedTypes.allowedFor(seller, job.sellerId);
    if (allowed === null) return wait(RETRY_SECONDS);
    const env = await readSellerCheckEnvironment(deps, market, allowed);
    if (!env.ok) return wait(RETRY_SECONDS);
    const columns = mapSellerColumns(table.value.header, job.mode, {
      optionCodes: optionColumnCodes(env.value),
      attributeCodes: attributeColumnCodes(env.value),
    });
    if (!columns.ok) return stop('file-missing');
    const map = columns.value;
    const groups = new Map<number, SellerGroupRows>(
      groupSellerRows(table.value.rows, map).map((group) => [group.groupRow, group]),
    );

    for (;;) {
      const pending = await this.#write(context, () =>
        deps.sellerJobs.pendingRows(market, job.id, BATCH),
      );
      if (pending.length === 0) {
        await this.#end(context, job, { state: 'finished' });
        return done('finished');
      }
      if (deps.clock.now().epochMilliseconds >= deadlineMs) {
        await this.#end(context, job, { state: 'queued', notBefore: null });
        return done('queued');
      }
      const leased = await this.#write(context, () =>
        deps.sellerJobs.renewLease(
          market,
          job.id,
          deps.clock.now().add({ seconds: LEASE_SECONDS }),
        ),
      );
      // Another runner took the job over (our lease had run out): leave it to them.
      if (!leased) return done('queued');

      // A seller who can no longer sell fails the rest and stops the job.
      if (!(await deps.eligibility.isEligible(seller, job.sellerId))) {
        return this.#ineligible(context, job, stop);
      }

      const byGroup = new Map<number, SellerRowRecord[]>();
      for (const row of pending) {
        byGroup.set(row.groupRow, [...(byGroup.get(row.groupRow) ?? []), row]);
      }
      const facts = await this.#facts(context, job, [...byGroup.keys()], groups, map);
      if (facts === null) return wait(RETRY_SECONDS);

      for (const [groupRow, rows] of byGroup) {
        const outcome = await this.#group(
          seller,
          job,
          rows,
          groups.get(groupRow),
          map,
          env.value,
          facts,
        );
        if (outcome.kind === 'done') {
          await this.#write(context, () =>
            deps.sellerJobs.settleGroup(market, job.id, groupRow, {
              state: outcome.state,
              productId: null,
              offerId: null,
              productCode: null,
            }),
          );
        } else if (outcome.kind === 'failed') {
          await this.#write(context, () =>
            deps.sellerJobs.settleGroup(market, job.id, groupRow, {
              state: 'failed',
              code: reasonOf(outcome.code),
            }),
          );
        } else if (outcome.kind === 'ineligible') {
          return this.#ineligible(context, job, stop);
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

  async #ineligible(
    context: CallContext,
    job: SellerImportJob,
    stop: (reason: SellerStopReason) => Promise<OwnImportRunOutput>,
  ): Promise<OwnImportRunOutput> {
    await this.#write(context, () =>
      this.deps.sellerJobs.failRemaining(context.market, job.id, 'seller.not-eligible'),
    );
    return stop('seller-not-eligible');
  }

  /** The facts of now for the SKUs and product codes of the groups of this batch. */
  async #facts(
    context: CallContext,
    job: SellerImportJob,
    groupRows: readonly number[],
    groups: ReadonlyMap<number, SellerGroupRows>,
    map: SellerColumnMap,
  ) {
    const skus = new Set<string>();
    const codes = new Set<string>();
    for (const groupRow of groupRows) {
      for (const cells of groups.get(groupRow)?.rows ?? []) {
        if (cells.text.sku !== '') skus.add(cells.text.sku);
        if (map.mode === 'sell-from-catalogue' && cells.text.productCode !== '') {
          codes.add(cells.text.productCode);
        }
      }
    }
    const read = await this.deps.unitOfWork.run(
      context.market,
      async () =>
        ok(
          await this.deps.importFacts.load(context.market, job.sellerId, {
            skus: [...skus],
            productCodes: [...codes],
          }),
        ),
      { readOnly: true },
    );
    return read.ok ? read.value : null;
  }

  /** One group: check again, then create or update through the row use cases. */
  async #group(
    seller: SellerJobContext,
    job: SellerImportJob,
    rows: readonly SellerRowRecord[],
    group: SellerGroupRows | undefined,
    map: SellerColumnMap,
    env: SellerCheckEnvironment,
    facts: SellerCheckFacts,
  ): Promise<GroupOutcome> {
    if (group === undefined) return { kind: 'failed', code: 'row.changed' };
    const recorded: Ids = {
      productId: rows.find((row) => row.productId !== null)?.productId ?? null,
      offerId: rows.find((row) => row.offerId !== null)?.offerId ?? null,
      productCode: rows.find((row) => row.productCode !== null)?.productCode ?? null,
    };
    // A group is checked again as a whole; a row that already left `pending` is part of the file's
    // group but not of this batch, so only a group that is whole in the batch is run.
    const checked = checkSellerGroup(group, map, env, facts);
    if (checked.plan === null) {
      // A group whose Offer a former attempt already made would now read as a repeat: it is done.
      if (map.mode === 'sell-from-catalogue' && recorded.offerId !== null) {
        return { kind: 'done', state: 'created' };
      }
      return { kind: 'failed', code: 'row.changed' };
    }
    try {
      return map.mode === 'my-products'
        ? await this.#productGroup(seller, job, checked.plan, recorded, env)
        : await this.#catalogueRow(seller, job, checked.plan, recorded, env);
    } catch (error) {
      this.#logger.error({
        msg: 'catalog.own-import-run',
        code: 'group-failed',
        reason: error instanceof Error ? error.name : 'unknown',
        marketId: seller.market.marketId,
        correlationId: seller.correlationId,
      });
      return { kind: 'transient' };
    }
  }

  async #record(seller: SellerJobContext, job: SellerImportJob, groupRow: number, ids: Ids) {
    await this.#write(seller, () =>
      this.deps.sellerJobs.recordGroup(seller.market, job.id, groupRow, ids),
    );
  }

  async #productGroup(
    seller: SellerJobContext,
    job: SellerImportJob,
    plan: SellerGroupPlan,
    recorded: Ids,
    env: SellerCheckEnvironment,
  ): Promise<GroupOutcome> {
    const { deps } = this;
    const product = plan.product;
    if (product === null) return { kind: 'failed', code: 'row.changed' };
    const description = plan.offerDescription;
    let productId = recorded.productId ?? plan.existing?.productId ?? null;
    let offerId = recorded.offerId ?? plan.existing?.offerId ?? null;
    let state: 'created' | 'updated' | 'unchanged' = plan.kind === 'create' ? 'created' : 'unchanged';

    if (productId === null || offerId === null) {
      const created = await deps.ownRowCreate.execute(seller, {
        typeCode: product.typeCode,
        sellerSku: plan.sellerSku,
        conditionCode: plan.conditionCode ?? env.conditions[0] ?? '',
        description: description === null ? {} : { [env.defaultLocale]: description },
      });
      if (!created.ok) return failureOf(created.error.code, created.error);
      productId = created.value.productId;
      offerId = created.value.offerId;
      // Remembered at once: a retry of this group never creates a second product.
      await this.#record(seller, job, plan.groupRow, {
        productId,
        offerId,
        productCode: created.value.productCode,
      });
    } else if (plan.kind === 'update') {
      const edited = await this.#editOffer(seller, offerId, plan, env);
      if (edited.kind === 'failed') return edited.outcome;
      if (edited.changed) state = 'updated';
    }

    const saved = await deps.ownRowSave.execute(seller, { productId, plan });
    if (!saved.ok) return failureOf(saved.error.code, saved.error);
    if (state === 'unchanged' && !saved.value.unchanged) state = 'updated';
    return { kind: 'done', state };
  }

  async #catalogueRow(
    seller: SellerJobContext,
    job: SellerImportJob,
    plan: SellerGroupPlan,
    recorded: Ids,
    env: SellerCheckEnvironment,
  ): Promise<GroupOutcome> {
    const { deps } = this;
    if (plan.kind === 'update' && plan.existing !== null) {
      const edited = await this.#editOffer(seller, plan.existing.offerId, plan, env);
      if (edited.kind === 'failed') return edited.outcome;
      return { kind: 'done', state: edited.changed ? 'updated' : 'unchanged' };
    }
    if (recorded.offerId !== null) return { kind: 'done', state: 'created' };
    const productId = plan.catalogueProduct?.productId;
    if (productId === undefined) return { kind: 'failed', code: 'row.changed' };
    const created = await deps.ownRowOfferCreate.execute(seller, {
      productId,
      sellerSku: plan.sellerSku,
      conditionCode: plan.conditionCode ?? env.conditions[0] ?? '',
      description:
        plan.offerDescription === null ? {} : { [env.defaultLocale]: plan.offerDescription },
    });
    if (!created.ok) return failureOf(created.error.code, created.error);
    await this.#record(seller, job, plan.groupRow, {
      productId,
      offerId: created.value.offerId,
      productCode: null,
    });
    return { kind: 'done', state: 'created' };
  }

  /** Edits the Offer with the cells the file gave; an empty cell keeps the stored value. */
  async #editOffer(
    seller: SellerJobContext,
    offerId: string,
    plan: SellerGroupPlan,
    env: SellerCheckEnvironment,
  ): Promise<
    | { readonly kind: 'ok'; readonly changed: boolean }
    | { readonly kind: 'failed'; readonly outcome: GroupOutcome }
  > {
    const { deps } = this;
    if (plan.conditionCode === null && plan.offerDescription === null) {
      return { kind: 'ok', changed: false };
    }
    const found = await deps.unitOfWork.run(
      seller.market,
      async () => ok(await deps.offers.findById(seller.market, offerId as Id<'Offer'>)),
      { readOnly: true },
    );
    if (!found.ok || found.value === null) return { kind: 'failed', outcome: { kind: 'transient' } };
    const stored = found.value.state;
    const conditionCode = plan.conditionCode ?? stored.conditionCode;
    const description =
      plan.offerDescription === null
        ? { ...stored.description }
        : { ...stored.description, [env.defaultLocale]: plan.offerDescription };
    const same =
      conditionCode === stored.conditionCode &&
      JSON.stringify(description) === JSON.stringify(stored.description);
    if (same) return { kind: 'ok', changed: false };
    const edited = await deps.ownRowOfferEdit.execute(seller, {
      offerId,
      sellerSku: stored.sellerSku,
      conditionCode,
      description,
    });
    if (!edited.ok) return { kind: 'failed', outcome: failureOf(edited.error.code, edited.error) };
    return { kind: 'ok', changed: true };
  }
}

/** Maps a use case's refusal to what the run does about it (the policy both imports share). */
function failureOf(code: string, detail?: unknown): GroupOutcome {
  // The seller can no longer sell: the rest of the rows fail and the job stops.
  if (code === 'seller.not-eligible' || code === 'access.seller-not-approved') {
    return { kind: 'ineligible' };
  }
  if (code === 'access.unauthenticated') return { kind: 'stop', reason: 'access-lost' };
  const action = failureActionOf(code, detail);
  switch (action.kind) {
    case 'wait':
      return { kind: 'wait', seconds: action.seconds };
    // The gate refused: the account lost a key (or the account) since the start.
    case 'access-lost':
      return { kind: 'stop', reason: 'access-lost' };
    case 'transient':
      return { kind: 'transient' };
    case 'failed':
      return { kind: 'failed', code: action.code };
  }
}

