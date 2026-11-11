import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { MailTransport } from '../../../../platform/mail/mail-transport';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { ProductCategoryOverriddenAudit, scopeCode } from '../../domain/audit';
import { categoryMoveNoticeMail } from '../../domain/category-move-notice';
import { MAX_TREE_NODES } from '../../domain/category-tree';
import {
  checkProductCategories,
  type ProductCategoryNode,
} from '../../domain/product-category-rules';
import { buildCategoryOverrideContent } from '../../domain/revision-freeze';
import type { StoredRevision } from '../../domain/stored-revision';
import type {
  FamilyResolutionSession,
  ProductFamilyResolver,
} from '../attributes/product-family-resolver';
import { revisionContentHash } from '../revisions/revision-content-hash';
import { markProductForReevaluation } from '../tags/publish-fan-out';
import type { AdminCategoryReader } from '../ports/admin-category.reader';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { CategoryProductMoveStore, MoveJobRecord } from '../ports/category-product-move.store';
import type { OfferRepository } from '../ports/offer.repository';
import type { OfferOwnerContact, OfferOwnerMailSettings } from '../ports/offer-owner-notices';
import type { ProductRepository } from '../ports/product.repository';
import type { ProductRevisionRepository } from '../ports/product-revision.repository';
import type { TagReevaluationRequestRepository } from '../ports/tag-reevaluation-requests';

/** Products moved per batch, in one unit each (brief C5a item 3). */
export const MOVE_BATCH_SIZE = 100;
/** The lease a runner holds on a job; renewed after every batch. */
export const MOVE_LEASE_MS = 2 * 60_000;
/** One turn works at most this long; the job's lock is longer, so a turn ends inside it. */
export const MOVE_TURN_MS = 8 * 60_000;
/** Seller emails sent per batch. */
const NOTICE_BATCH = 100;
/** A product unit publishes a revision and marks every Offer of the product: room for a large one. */
const PRODUCT_UNIT_TIMEOUT_MS = 30_000;

export interface CategoryMoveProductsRunInput {
  readonly budgetMs: number;
}

export type CategoryMoveProductsRunOutput =
  | { readonly ran: false }
  | {
      readonly ran: true;
      readonly jobId: Id<'CategoryMoveJob'>;
      /**
       * `notices-pending`: every product is handled but a seller email could not be sent; the job
       * stays running and the next turn (after the lease ran out) tries the email again.
       */
      readonly outcome: 'done' | 'failed' | 'budget' | 'lease-lost' | 'notices-pending';
      readonly moved: number;
      readonly skipped: number;
      readonly failed: number;
    };

export interface CategoryMoveProductsRunDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly moveStore: CategoryProductMoveStore;
  readonly products: ProductRepository;
  readonly revisions: ProductRevisionRepository;
  readonly familyResolver: ProductFamilyResolver;
  readonly adminCategoryReader: AdminCategoryReader;
  readonly policy: CatalogMarketPolicy;
  readonly offers: OfferRepository;
  readonly requests: TagReevaluationRequestRepository;
  readonly outbox: OutboxWriter;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly ownerContacts: OfferOwnerContact;
  readonly mailSettings: OfferOwnerMailSettings;
  readonly mailTransport: MailTransport;
}

/**
 * What a batch reads once: the tree, the Market's depth and the family resolution. The target is
 * re-read fresh in every product unit (see `#moveOne`).
 */
interface MoveEnvironment {
  readonly nodes: Awaited<ReturnType<AdminCategoryReader['categories']>>;
  readonly maxLevel: number;
  readonly family: FamilyResolutionSession;
}

type ItemOutcome = 'moved' | 'skipped' | 'failed' | 'handled';
type TurnOutcome = 'done' | 'failed' | 'budget' | 'lease-lost' | 'notices-pending';

/**
 * `catalog.run-category-product-moves` (categories package C5a, decision 8): the job behind
 * "Move products". Rule `system`, one call per hosted Market. A turn claims the oldest queued job
 * (or a running one whose lease ran out) and works it in batches of {@link MOVE_BATCH_SIZE}
 * products: for each product whose published revision still names the source, one unit builds a
 * `category-override` revision (the published content with the source replaced by the target; the
 * target becomes primary when the source was), publishes it at once, marks the Offers' tags
 * `rechecking` and asks the fan-out again, audits, and records the product's item. The item row is
 * unique per job and product, so a product is never moved twice and a resumed job (a crashed
 * runner, an expired lease) skips what an earlier turn did. After each batch the seller of each
 * moved product gets one email, marked on the item; the job is done only once every moved
 * product's email is marked. The mail is at-least-once: a crash between the send and the mark
 * sends that email again next turn. The lease is renewed after every product, and the job's
 * counters are counted from its items, never accumulated. The target is re-checked against fresh
 * rows in every product unit: a target archived or moved off levels 3..depth mid-job fails that
 * product, not the job. The runner is the system; the audit names the admin who started the job.
 * A tree that cannot be read fails the job.
 */
export class CategoryMoveProductsRun extends UseCase<
  CategoryMoveProductsRunInput,
  CategoryMoveProductsRunOutput,
  { readonly code: 'access.denied' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-move-products-run',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('CategoryMoveProductsRun');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryMoveProductsRunDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CategoryMoveProductsRunInput,
  ): Promise<Result<CategoryMoveProductsRunOutput, { readonly code: 'access.denied' }>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { deps } = this;
    const { market } = context;
    const holder = randomUUID();
    const started = deps.clock.now();
    const job = await this.#write(context, () =>
      deps.moveStore.claim(market, holder, started, started.add({ milliseconds: MOVE_LEASE_MS })),
    );
    if (job === null) return ok({ ran: false });

    const totals = { moved: 0, skipped: 0, failed: 0 };
    const end = async (outcome: TurnOutcome) => {
      if (outcome === 'done' || outcome === 'failed') {
        await this.#write(context, () =>
          deps.moveStore.finish(market, job.id, holder, outcome, deps.clock.now()),
        );
      }
      this.#logger.log({
        msg: 'catalog.run-category-product-moves',
        code: outcome,
        jobId: job.id,
        ...totals,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return ok<CategoryMoveProductsRunOutput>({ ran: true, jobId: job.id, outcome, ...totals });
    };

    const overBudget = (): boolean =>
      deps.clock.now().epochMilliseconds - started.epochMilliseconds >= input.budgetMs;
    let current: MoveJobRecord = job;
    for (;;) {
      if (overBudget()) return end('budget');
      const batch = await this.#read(context, () =>
        deps.moveStore.nextProducts(market, current, MOVE_BATCH_SIZE),
      );
      if (batch.length === 0) {
        // Done only once every moved product's seller email is marked (L3).
        const drained = await this.#notifySellers(context, current, overBudget);
        return end(drained ? 'done' : 'notices-pending');
      }
      const environment = await this.#environment(context);
      if (environment === null) {
        // The tree cannot be read (over the cap): nothing can be checked, so nothing is moved.
        this.#logger.error({
          msg: 'catalog.run-category-product-moves.tree-unavailable',
          jobId: current.id,
          marketId: market.marketId,
          correlationId: context.correlationId,
        });
        const drained = await this.#notifySellers(context, current, overBudget);
        return end(drained ? 'failed' : 'notices-pending');
      }
      let handled: Id<'Product'> | null = null;
      for (const productId of batch) {
        const outcome = await this.#moveOne(context, current, productId, environment);
        if (outcome === 'moved') totals.moved += 1;
        else if (outcome === 'skipped') totals.skipped += 1;
        else if (outcome === 'failed') totals.failed += 1;
        handled = productId;
        // Renew after every product (L2): a slow batch never outlives the lease unnoticed.
        const kept = await this.#write(context, () =>
          deps.moveStore.renew(
            market,
            current.id,
            holder,
            deps.clock.now().add({ milliseconds: MOVE_LEASE_MS }),
          ),
        );
        if (!kept) return end('lease-lost');
        if (overBudget()) break;
      }
      const cursor = handled!;
      const advanced = await this.#write(context, async () => {
        const kept = await deps.moveStore.advance(market, current.id, holder, cursor);
        if (kept) {
          await deps.moveStore.renew(
            market,
            current.id,
            holder,
            deps.clock.now().add({ milliseconds: MOVE_LEASE_MS }),
          );
        }
        return kept;
      });
      if (!advanced) return end('lease-lost');
      await this.#notifySellers(context, current, overBudget);
      current = { ...current, cursorProductId: cursor };
    }
  }

  /** The tree and the family resolution, read once per batch; null when the tree cannot be read. */
  async #environment(context: CallContext): Promise<MoveEnvironment | null> {
    const { deps } = this;
    const { market } = context;
    return this.#read(context, async () => {
      const nodes = await deps.adminCategoryReader.categories(market, MAX_TREE_NODES + 1);
      if (nodes.length > MAX_TREE_NODES) return null;
      const maxLevel = deps.policy.maxCategoryDepth(market);
      const family = await deps.familyResolver.open(market);
      return { nodes, maxLevel, family };
    });
  }

  async #moveOne(
    context: CallContext,
    job: MoveJobRecord,
    productId: Id<'Product'>,
    environment: MoveEnvironment,
  ): Promise<ItemOutcome> {
    const { deps } = this;
    const { market } = context;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const done = await deps.unitOfWork.run<ItemOutcome, never>(
          market,
          async () => {
            const now = deps.clock.now();
            const product = await deps.products.findById(market, productId);
            const publishedId = product?.state.publishedRevisionId ?? null;
            const skip = async (): Promise<Result<ItemOutcome, never>> =>
              ok(
                (await deps.moveStore.recordItem(
                  market,
                  job.id,
                  productId,
                  { state: 'skipped' },
                  now,
                ))
                  ? 'skipped'
                  : 'handled',
              );
            const fail = async (): Promise<Result<ItemOutcome, never>> =>
              ok(
                (await deps.moveStore.recordItem(
                  market,
                  job.id,
                  productId,
                  { state: 'failed' },
                  now,
                ))
                  ? 'failed'
                  : 'handled',
              );
            if (product === null || product.state.status !== 'published' || publishedId === null) {
              return skip();
            }
            const published = await deps.revisions.find(market, productId, publishedId);
            if (published === null) return fail();
            const built = buildCategoryOverrideContent(
              published.content,
              job.sourceCategoryId,
              job.targetCategoryId,
            );
            // The source is no longer on the published revision: an earlier turn or a seller
            // submit already took the product off it.
            if (!built.ok) return skip();
            // The target as it is now (L4): its row and its ancestors, read in this unit, over the
            // batch's tree. Archived, merged, gone or off levels 3..depth fails this product only.
            const chain = await deps.moveStore.categoryChain(market, job.targetCategoryId);
            const fresh = new Map<string, ProductCategoryNode>(
              environment.nodes.map((node) => [node.id, node]),
            );
            if (chain.length === 0) fresh.delete(job.targetCategoryId);
            for (const node of chain) fresh.set(node.id, node);
            if (
              checkProductCategories(
                [...fresh.values()],
                built.value.categoryIds,
                environment.maxLevel,
              ).length > 0
            ) {
              return fail();
            }
            const family = await environment.family.resolve(built.value.categoryIds[0] ?? null);
            if (!family.ok) return fail();

            const revisionId = deps.ids.next<'ProductRevision'>();
            // The item first, before the aggregate changes: a second turn on the same product
            // stops here. It is `pending` with no revision: the item's foreign key names a
            // revision row, which does not exist yet; `markMoved` below names it once written.
            // A refusal below throws, which rolls this unit (and the item) back; the catch
            // records the product as failed in a unit of its own.
            if (
              !(await deps.moveStore.recordItem(
                market,
                job.id,
                productId,
                { state: 'pending' },
                now,
              ))
            ) {
              return ok('handled');
            }
            const revisionNo = await deps.revisions.nextRevisionNo(market, productId);
            const overridden = product.publishCategoryOverride({
              revisionId,
              fromRevisionId: publishedId,
              familyCode: family.familyCode,
              now,
            });
            if (!overridden.ok) throw new Error('category-move-products: the publish was refused');
            const revision: StoredRevision = {
              id: revisionId,
              productId,
              revisionNo,
              kind: 'category-override',
              baseRevisionId: publishedId,
              revertedFromRevisionId: null,
              sensitive: false,
              sensitiveReasons: [],
              contentHash: revisionContentHash(built.value),
              authorKind: 'admin',
              authorAccountId: job.createdByAccountId,
              actingAdminAccountId: null,
              submittedAt: now,
              content: built.value,
            };
            await deps.revisions.add(market, revision);
            if (!(await deps.moveStore.markMoved(market, job.id, productId, revisionId))) {
              throw new Error('category-move-products: the pending item is gone');
            }
            await deps.products.save(market, product);
            // Lock order: the product row (saved above), then its Offers.
            await markProductForReevaluation(deps, market, {
              productId,
              revisionId,
              actor: { kind: 'system', accountId: null },
              now,
            });
            await deps.outbox.append(context, product.pendingEvents);
            await deps.audit.record(
              context,
              ProductCategoryOverriddenAudit.entry(productId, {
                before: { fromCategoryId: job.sourceCategoryId },
                after: {
                  toCategoryId: job.targetCategoryId,
                  categoryCount: built.value.categoryIds.length,
                  scope: scopeCode(product.state.scope),
                  jobId: job.id,
                  requestedBy: job.createdByAccountId,
                },
              }),
            );
            return ok('moved');
          },
          { timeoutMs: PRODUCT_UNIT_TIMEOUT_MS },
        );
        if (!done.ok) throw new Error('category-move-products: the product unit failed');
        return done.value;
      } catch (error) {
        // A seller submit or another publish won the product row: read it again once.
        if (error instanceof StaleAggregateError && attempt === 0) continue;
        this.#logger.error({
          msg: 'catalog.run-category-product-moves.item-failed',
          jobId: job.id,
          marketId: market.marketId,
          correlationId: context.correlationId,
        });
        // The item is recorded in a unit of its own, so the batch goes on and counts it.
        const recorded = await this.#write(context, () =>
          deps.moveStore.recordItem(
            market,
            job.id,
            productId,
            { state: 'failed' },
            deps.clock.now(),
          ),
        );
        return recorded ? 'failed' : 'handled';
      }
    }
    return 'failed';
  }

  /**
   * One email per moved product whose seller has not been told, in pages until none is left.
   * True when every moved item is marked; false when a send failed (tried again next turn) or the
   * turn's budget ran out. At-least-once: the mark is written after the send, so a crash between
   * the two sends that email again.
   */
  async #notifySellers(
    context: CallContext,
    job: MoveJobRecord,
    overBudget: () => boolean,
  ): Promise<boolean> {
    const { deps } = this;
    const { market } = context;
    let names: { readonly from: string; readonly to: string } | null = null;
    for (;;) {
      const pending = await this.#read(context, () =>
        deps.moveStore.unnotified(market, job.id, NOTICE_BATCH),
      );
      if (pending.length === 0) return true;
      names ??= await this.#read(context, async () => {
        const nodes = await deps.adminCategoryReader.categories(market, MAX_TREE_NODES + 1);
        const locale = deps.policy.locales(market).default;
        const nameOf = (id: string): string => {
          const node = nodes.find((entry) => entry.id === id);
          return (node?.names.find((n) => n.locale === locale) ?? node?.names[0])?.name ?? '';
        };
        return { from: nameOf(job.sourceCategoryId), to: nameOf(job.targetCategoryId) };
      });
      let marked = 0;
      for (const { productId } of pending) {
        try {
          const product = await this.#read(context, () =>
            deps.products.findById(market, productId),
          );
          const sellerId = product?.state.ownerSellerId ?? null;
          if (product !== null && sellerId !== null) {
            const to = await deps.ownerContacts.emailOf(context, sellerId);
            if (to !== null) {
              const mail = categoryMoveNoticeMail({
                productCode: product.state.productCode,
                fromName: names.from,
                toName: names.to,
              });
              // At-least-once: sent before the mark below is committed.
              await deps.mailTransport.send({
                to,
                from: deps.mailSettings.sender(market),
                subject: mail.subject,
                text: mail.text,
              });
            }
          }
          // No owner (a PLATFORM product) or no usable address: nothing to send, nothing to retry.
          await this.#write(context, () =>
            deps.moveStore.markNotified(market, job.id, productId, deps.clock.now()),
          );
          marked += 1;
        } catch {
          this.#logger.warn({
            msg: 'catalog.run-category-product-moves.notice-deferred',
            jobId: job.id,
            marketId: market.marketId,
            correlationId: context.correlationId,
          });
        }
      }
      // A failed send stays unmarked: stop here (the page would only return it again).
      if (marked < pending.length || overBudget()) return false;
    }
  }

  async #read<T>(context: CallContext, work: () => Promise<T>): Promise<T> {
    const done = await this.deps.unitOfWork.run(context.market, async () => ok(await work()), {
      readOnly: true,
    });
    if (!done.ok) throw new Error('category-move-products: the read unit failed');
    return done.value;
  }

  async #write<T>(context: CallContext, work: () => Promise<T>): Promise<T> {
    const done = await this.deps.unitOfWork.run(context.market, async () => ok(await work()), {
      timeoutMs: 30_000,
    });
    if (!done.ok) throw new Error('category-move-products: the unit failed');
    return done.value;
  }
}
