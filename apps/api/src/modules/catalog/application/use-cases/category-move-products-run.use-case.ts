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
import { checkProductCategories } from '../../domain/product-category-rules';
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
      readonly outcome: 'done' | 'failed' | 'budget' | 'lease-lost';
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

/** What a batch reads once: the tree, the Market's depth and the family resolution. */
interface MoveEnvironment {
  readonly nodes: Awaited<ReturnType<AdminCategoryReader['categories']>>;
  readonly maxLevel: number;
  readonly family: FamilyResolutionSession;
}

type ItemOutcome = 'moved' | 'skipped' | 'failed' | 'handled';

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
 * moved product gets one email, marked on the item. The runner is the system; the audit names the
 * admin who started the job. A target that is no longer a valid product category fails the job.
 */
export class CategoryMoveProductsRun extends UseCase<
  CategoryMoveProductsRunInput,
  CategoryMoveProductsRunOutput,
  { readonly code: 'access.denied' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.run-category-product-moves',
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
    const end = async (outcome: 'done' | 'failed' | 'budget' | 'lease-lost') => {
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

    let current: MoveJobRecord = job;
    for (;;) {
      const now = deps.clock.now();
      if (now.epochMilliseconds - started.epochMilliseconds >= input.budgetMs) {
        return end('budget');
      }
      const batch = await this.#read(context, () =>
        deps.moveStore.nextProducts(market, current, MOVE_BATCH_SIZE),
      );
      if (batch.length === 0) {
        await this.#notifySellers(context, current);
        return end('done');
      }
      const environment = await this.#environment(context, current);
      if (environment === null) {
        // The target is gone or no longer a product category: nothing more can be moved.
        this.#logger.error({
          msg: 'catalog.run-category-product-moves.target-invalid',
          jobId: current.id,
          marketId: market.marketId,
          correlationId: context.correlationId,
        });
        return end('failed');
      }
      let moved = 0;
      let skipped = 0;
      let failed = 0;
      for (const productId of batch) {
        const outcome = await this.#moveOne(context, current, productId, environment);
        if (outcome === 'moved') moved += 1;
        else if (outcome === 'skipped') skipped += 1;
        else if (outcome === 'failed') failed += 1;
      }
      totals.moved += moved;
      totals.skipped += skipped;
      totals.failed += failed;
      const advanced = await this.#write(context, async () => {
        const kept = await deps.moveStore.advance(market, current.id, holder, {
          cursor: batch[batch.length - 1]!,
          moved,
          skipped,
          failed,
        });
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
      await this.#notifySellers(context, current);
      current = {
        ...current,
        cursorProductId: batch[batch.length - 1]!,
      };
    }
  }

  /** The tree and the family resolution, read once per batch; null when the target no longer fits. */
  async #environment(context: CallContext, job: MoveJobRecord): Promise<MoveEnvironment | null> {
    const { deps } = this;
    const { market } = context;
    return this.#read(context, async () => {
      const nodes = await deps.adminCategoryReader.categories(market, MAX_TREE_NODES + 1);
      if (nodes.length > MAX_TREE_NODES) return null;
      const maxLevel = deps.policy.maxCategoryDepth(market);
      const issues = checkProductCategories(nodes, [job.targetCategoryId], maxLevel);
      if (issues.length > 0) return null;
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
            if (
              checkProductCategories(
                environment.nodes,
                built.value.categoryIds,
                environment.maxLevel,
              ).length > 0
            ) {
              return fail();
            }
            const family = await environment.family.resolve(built.value.categoryIds[0] ?? null);
            if (!family.ok) return fail();

            const revisionId = deps.ids.next<'ProductRevision'>();
            const revisionNo = await deps.revisions.nextRevisionNo(market, productId);
            const published2 = product.publishCategoryOverride({
              revisionId,
              fromRevisionId: publishedId,
              familyCode: family.familyCode,
              now,
            });
            if (!published2.ok) return fail();
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
            // The item first: a second turn on the same product stops here.
            if (
              !(await deps.moveStore.recordItem(
                market,
                job.id,
                productId,
                { state: 'moved', revisionId },
                now,
              ))
            ) {
              return ok('handled');
            }
            await deps.revisions.add(market, revision);
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

  /** One email per moved product whose seller has not been told; a failed send is tried next turn. */
  async #notifySellers(context: CallContext, job: MoveJobRecord): Promise<void> {
    const { deps } = this;
    const { market } = context;
    const pending = await this.#read(context, () =>
      deps.moveStore.unnotified(market, job.id, NOTICE_BATCH),
    );
    if (pending.length === 0) return;
    const names = await this.#read(context, async () => {
      const nodes = await deps.adminCategoryReader.categories(market, MAX_TREE_NODES + 1);
      const locale = deps.policy.locales(market).default;
      const nameOf = (id: string): string => {
        const node = nodes.find((entry) => entry.id === id);
        return (node?.names.find((n) => n.locale === locale) ?? node?.names[0])?.name ?? '';
      };
      return { from: nameOf(job.sourceCategoryId), to: nameOf(job.targetCategoryId) };
    });
    for (const { productId } of pending) {
      try {
        const product = await this.#read(context, () => deps.products.findById(market, productId));
        const sellerId = product?.state.ownerSellerId ?? null;
        if (product !== null && sellerId !== null) {
          const to = await deps.ownerContacts.emailOf(context, sellerId);
          if (to !== null) {
            const mail = categoryMoveNoticeMail({
              productCode: product.state.productCode,
              fromName: names.from,
              toName: names.to,
            });
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
      } catch {
        this.#logger.warn({
          msg: 'catalog.run-category-product-moves.notice-deferred',
          jobId: job.id,
          marketId: market.marketId,
          correlationId: context.correlationId,
        });
      }
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
