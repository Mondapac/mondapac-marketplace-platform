import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type {
  CallContext,
  Clock,
  Id,
  IdGenerator,
  MarketContext,
  Result,
} from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  CATALOG_CATEGORY_TREE_RESTRUCTURE,
  CATALOG_PRODUCT_APPROVE,
} from '../../contracts/permissions';
import { PlatformCategoryProductsMoveStartedAudit } from '../../domain/audit';
import { MAX_TREE_NODES } from '../../domain/category-tree';
import { checkProductCategories } from '../../domain/product-category-rules';
import type { AdminCategoryReader } from '../ports/admin-category.reader';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { CategoryProductMoveStore } from '../ports/category-product-move.store';
import { categoryIdOf, closedInput, editorAccountOf, invalid } from '../categories/category-editor';
import type { ValidationFailure } from '../categories/category-admin-views';
import { reasonOf } from '../categories/category-restructure';
import type { SystemActionProposer, SystemRequestRecorder } from '../../../system-requests';
import { productsMoveValues } from '../catalogue-actions';
import {
  CATEGORY_PRODUCTS_MOVE_SUBJECT_KIND,
  catalogueReview,
  noteOr,
  proposeCatalogueAction,
  requestRef,
  type ProposedOr,
} from '../catalogue-review';

export interface CategoryMoveProductsInput {
  readonly [key: string]: unknown;
}

const KEYS = ['categoryId', 'targetId', 'reason', 'note'] as const;

export interface CategoryMoveProductsOutput {
  readonly jobId: Id<'CategoryMoveJob'>;
  /** Published products the job will move (the count preview; the run re-reads the set). */
  readonly products: number;
}

export type CategoryMoveProductsFailure =
  | ValidationFailure
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'category.not-found' }
  | { readonly code: 'category.target-not-found' }
  | { readonly code: 'category.move-unchanged' }
  | { readonly code: 'category.level-not-allowed' }
  | { readonly code: 'category.not-editable' }
  | { readonly code: 'category.no-products' }
  | { readonly code: 'category.move-in-progress' }
  | { readonly code: 'catalog.categories-unavailable' }
  | { readonly code: 'system-requests.already-pending'; readonly pendingNumber: number };

export interface CategoryMoveProductsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly adminCategoryReader: AdminCategoryReader;
  readonly moveStore: CategoryProductMoveStore;
  readonly policy: CatalogMarketPolicy;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** The review policy of area catalogue (whether the move waits for approval). */
  readonly review: Pick<SystemRequestRecorder, 'areaPolicy'>;
  /** Files the move for a second admin's approval (Admin Inbox › System requests). */
  readonly proposer: SystemActionProposer;
}

/**
 * `platform-category.move-products` (categories package C5a, decision 8): an admin moves every
 * published product of category X to category Y with a reason note. Starts the job
 * `catalog.run-category-product-moves`, which publishes a `category-override` revision per product
 * at once, audits, emails the seller and asks the tags again. Y must be a live category on level
 * 3 up to the Market's depth (`catalog.maxCategoryDepth`); X may be any live category, since
 * products that still sit on a level 1 or 2 category are exactly what an admin wants to move. X
 * and Y are in this Market or both answer `category.not-found` / `category.target-not-found`.
 * Rule: `catalog.category-tree.restructure` (protected) and `catalog.product.approve`; refused in an
 * acting-as session. Refused when X has no published product and when X already has a queued or
 * running job.
 *
 * Where the Market reviews area catalogue it waits for a second admin's approval (owner decision
 * of 18 Nov 2026): after the same checks the answer is the proposal (`request`; the `note`, or the
 * reason note when none is given) and no job starts. The approval runs the same checks and starts
 * the job as the approving admin (catalogue-appliers.ts); the job then runs as any other.
 */
export class CategoryMoveProducts extends UseCase<
  CategoryMoveProductsInput,
  ProposedOr<CategoryMoveProductsOutput>,
  CategoryMoveProductsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-move-products',
    rule: {
      kind: 'permissions',
      allOf: [CATALOG_CATEGORY_TREE_RESTRUCTURE.key, CATALOG_PRODUCT_APPROVE.key],
    },
  };

  readonly #logger = new Logger('CategoryMoveProducts');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryMoveProductsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CategoryMoveProductsInput,
  ): Promise<Result<ProposedOr<CategoryMoveProductsOutput>, CategoryMoveProductsFailure>> {
    const result = await this.#run(context, input);
    this.#logger.log({
      msg: 'catalog.category-move-products',
      code: result.ok ? ('jobId' in result.value ? 'queued' : 'proposed') : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #run(
    context: CallContext,
    input: CategoryMoveProductsInput,
  ): Promise<Result<ProposedOr<CategoryMoveProductsOutput>, CategoryMoveProductsFailure>> {
    const accountId = editorAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, KEYS);
    if (!body.ok) return body;
    const source = categoryIdOf(body.value['categoryId']);
    if (!source.ok) return source;
    const rawTarget = body.value['targetId'];
    if (rawTarget === undefined) return invalid('targetId', 'required');
    const target = categoryIdOf(rawTarget);
    if (!target.ok) return err({ code: 'category.target-not-found' });
    const reason = reasonOf(body.value['reason']);
    if (!reason.ok) return reason;
    if (source.value === target.value) return err({ code: 'category.move-unchanged' });

    const { deps } = this;
    const { market } = context;
    let maxLevel: number;
    try {
      maxLevel = deps.policy.maxCategoryDepth(market);
    } catch {
      return err({ code: 'access.unavailable' });
    }
    // Its own read-only unit, before this one (units do not nest).
    const policy = await catalogueReview(deps.review, context);
    const done = await deps.unitOfWork.run<
      ProposedOr<CategoryMoveProductsOutput>,
      CategoryMoveProductsFailure
    >(
      market,
      async () => {
        const checked = await checkProductsMove(deps, market, {
          sourceId: source.value,
          targetId: target.value,
          maxLevel,
        });
        if (!checked.ok) return checked;
        if (policy.reviewed) {
          const proposed = await proposeCatalogueAction(deps.proposer, context, policy, {
            subjectKind: CATEGORY_PRODUCTS_MOVE_SUBJECT_KIND,
            subjectRef: source.value,
            before: { status: checked.value.source.status },
            after: productsMoveValues({
              action: 'move-products',
              targetId: target.value,
              reason: reason.value,
              products: checked.value.products,
            }),
            note: noteOr(body.value['note'], reason.value),
            tooLargePath: 'reason',
          });
          if (!proposed.ok) return err(proposed.error);
          const request = requestRef(proposed.value);
          if (request !== null) return ok({ request });
        }
        return startProductsMoveInUnit(deps, context, accountId, {
          sourceId: source.value,
          targetId: target.value,
          reason: reason.value,
          products: checked.value.products,
          requestId: null,
        });
      },
      { timeoutMs: 30_000 },
    );
    return done;
  }
}

/**
 * The checks of a move of products, inside the open unit: X is a live category of the Market, Y a
 * live category on an allowed level, and X has published products (their count). Shared by the
 * route and by the approval of a proposed move.
 */
export async function checkProductsMove(
  deps: Pick<CategoryMoveProductsDependencies, 'adminCategoryReader' | 'moveStore'>,
  market: MarketContext,
  move: {
    readonly sourceId: Id<'Category'>;
    readonly targetId: Id<'Category'>;
    readonly maxLevel: number;
  },
): Promise<
  Result<
    { readonly source: { readonly status: string }; readonly products: number },
    CategoryMoveProductsFailure
  >
> {
  const nodes = await deps.adminCategoryReader.categories(market, MAX_TREE_NODES + 1);
  if (nodes.length > MAX_TREE_NODES) return err({ code: 'catalog.categories-unavailable' });
  const from = nodes.find((node) => node.id === move.sourceId);
  if (from === undefined) return err({ code: 'category.not-found' });
  if (!nodes.some((node) => node.id === move.targetId)) {
    return err({ code: 'category.target-not-found' });
  }
  if (from.status !== 'active' && from.status !== 'hidden') {
    return err({ code: 'category.not-editable' });
  }
  const issues = checkProductCategories(nodes, [move.targetId], move.maxLevel);
  if (issues.length > 0) {
    const first = issues[0]!;
    return err(
      first.code === 'category.level-not-allowed'
        ? { code: 'category.level-not-allowed' }
        : first.code === 'category.not-available'
          ? { code: 'category.not-editable' }
          : { code: 'category.target-not-found' },
    );
  }
  const products = await deps.moveStore.countProducts(market, move.sourceId);
  if (products === 0) return err({ code: 'category.no-products' });
  return ok({ source: { status: from.status }, products });
}

/**
 * Starts the job inside the open unit, after {@link checkProductsMove}: one queued job per source
 * (`category.move-in-progress` while another is queued or running) and its audit row, naming the
 * request whose approval started it (null for an admin's own start).
 */
export async function startProductsMoveInUnit(
  deps: Pick<CategoryMoveProductsDependencies, 'moveStore' | 'audit' | 'clock' | 'ids'>,
  context: CallContext,
  accountId: Id<'Account'>,
  move: {
    readonly sourceId: Id<'Category'>;
    readonly targetId: Id<'Category'>;
    readonly reason: string;
    readonly products: number;
    readonly requestId: Id<'SystemRequest'> | null;
  },
): Promise<Result<CategoryMoveProductsOutput, CategoryMoveProductsFailure>> {
  const jobId = deps.ids.next<'CategoryMoveJob'>();
  const inserted = await deps.moveStore.insertJob(context.market, {
    id: jobId,
    sourceCategoryId: move.sourceId,
    targetCategoryId: move.targetId,
    reason: move.reason,
    createdByAccountId: accountId,
    total: move.products,
    now: deps.clock.now(),
  });
  if (!inserted) return err({ code: 'category.move-in-progress' });
  await deps.audit.record(
    context,
    PlatformCategoryProductsMoveStartedAudit.entry(move.sourceId, {
      before: { products: move.products },
      after: {
        targetCategoryId: move.targetId,
        jobId,
        reasonGiven: true,
        requestId: move.requestId,
      },
    }),
  );
  return ok({ jobId, products: move.products });
}
