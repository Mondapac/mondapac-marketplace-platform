import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PlatformCategory } from '../../domain/platform-category';
import type { CategorySeed } from '../ports/category-seed';
import type { PlatformCategoryRepository } from '../ports/platform-category.repository';

export interface SeedCategoryTreeOutput {
  /** Categories created by this run; 0 once the Market is seeded. */
  readonly created: number;
}

export type SeedCategoryTreeFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'category.seed-invalid'; readonly slug: string; readonly reason: string };

export interface SeedCategoryTreeDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly categories: PlatformCategoryRepository;
  readonly seed: CategorySeed;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * The seed routine of catalog design 4.6 and 7.2 for the platform category tree (slice 2). Rule
 * `system`, run per hosted Market at worker start and then daily. For each category of the
 * Market's checked-in seed whose slug is missing, one unit creates it with its first revision,
 * raises the tree version and announces `catalog.platform-category-created.v1`. It only ever
 * creates (Ali B4): it has no update path, an existing slug is skipped whatever its state, and
 * the application holds no grant a seed could use to rewrite a category. A concurrent or
 * repeated run converges on the unique slug and the tree version guard: the loser's unit is
 * stale, fails, and the next run finds the work done. The claim-text check of seed names joins
 * with slice 5.
 */
export class SeedCategoryTree extends UseCase<
  Record<string, never>,
  SeedCategoryTreeOutput,
  SeedCategoryTreeFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.seed-category-tree',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('SeedCategoryTree');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SeedCategoryTreeDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<SeedCategoryTreeOutput, SeedCategoryTreeFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { market } = context;
    const { unitOfWork, categories, seed, outbox, clock, ids } = this.deps;
    let created = 0;
    for (const seeded of seed.tree(market)) {
      const done = await unitOfWork.run(market, async () => {
        if ((await categories.idBySlug(market, seeded.slug)) !== null) return ok(false);
        let parentId: Id<'Category'> | null = null;
        if (seeded.parentSlug !== null) {
          parentId = await categories.idBySlug(market, seeded.parentSlug);
          if (parentId === null) return err('parent-missing' as const);
        }
        const category = PlatformCategory.create({
          id: ids.next<'Category'>(),
          revisionId: ids.next<'CategoryRevision'>(),
          marketId: market.marketId,
          parentId,
          verticalRootCode: seeded.verticalRootCode,
          slug: seeded.slug,
          names: seeded.names,
          createdByKind: 'seed',
          now: clock.now(),
        });
        if (!category.ok) return err(category.error.code);
        const tree = await categories.treeVersion(market);
        await categories.add(market, category.value);
        await categories.bumpTreeVersion(market, tree.version);
        await outbox.append(context, category.value.pendingEvents);
        return ok(true);
      });
      if (!done.ok) {
        return err({ code: 'category.seed-invalid', slug: seeded.slug, reason: done.error });
      }
      if (done.value) {
        created += 1;
        this.#logger.log({
          msg: 'catalog.seed-category-tree.created',
          slug: seeded.slug,
          marketId: market.marketId,
          correlationId: context.correlationId,
        });
      }
    }
    return ok({ created });
  }
}
