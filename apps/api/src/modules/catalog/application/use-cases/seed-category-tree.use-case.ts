import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { PlatformCategory } from '../../domain/platform-category';
import { checkSeedTexts, type SeedClaimRefusal } from '../claim-text/seed-claim-check';
import type { CheckClaimText } from '../claim-text/check-claim-text.service';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { CategorySeed } from '../ports/category-seed';
import type { PlatformCategoryRepository } from '../ports/platform-category.repository';

export interface SeedCategoryTreeOutput {
  /** Categories created by this run; 0 once the Market is seeded. */
  readonly created: number;
}

export type SeedCategoryTreeFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'category.seed-invalid'; readonly slug: string; readonly reason: string }
  | SeedClaimRefusal;

export interface SeedCategoryTreeDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly categories: PlatformCategoryRepository;
  readonly seed: CategorySeed;
  readonly check: CheckClaimText;
  readonly policy: CatalogMarketPolicy;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * The seed routine of catalog design 4.6 and 7.2 for the platform category tree (slice 2). Rule
 * `system`, run per hosted Market at worker start and then daily. For each category of the
 * Market's checked-in seed whose slug is missing, one unit creates it with its first revision,
 * raises the tree version and announces `catalog.platform-category-created.v1`. It only ever
 * creates (Ali B4): an existing slug is skipped whatever its state, and
 * its code has no update path to rewrite a category (the grants allow only the structural columns
 * slice 21's editor needs, and never slug, creator kind, names or revision history). A concurrent or
 * repeated run converges on the unique slug and the tree version guard: the loser's unit is
 * stale, fails, and the next run finds the work done. Before anything is written, every name and
 * slug of the seed passes the claim-text check as the system actor (design 7.2, ADR-0031 d3); a
 * match or an unavailable check refuses the whole run.
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
    const { unitOfWork, categories, seed, outbox, clock, ids, check, policy } = this.deps;
    const tree = seed.tree(market);
    let defaultLocale: string;
    try {
      defaultLocale = policy.locales(market).default;
    } catch {
      return err({ code: 'seed.claim-text-unavailable', places: [] });
    }
    const checked = await checkSeedTexts(
      check,
      policy,
      context,
      tree.flatMap((seeded) => [
        {
          field: 'platform-category.slug' as const,
          ref: seeded.slug,
          locale: defaultLocale,
          text: seeded.slug,
        },
        ...seeded.names.map(({ locale, name }) => ({
          field: 'platform-category.name' as const,
          ref: seeded.slug,
          locale,
          text: name,
        })),
      ]),
    );
    if (!checked.ok) {
      this.#logger.error({
        msg: 'catalog.seed-category-tree.claim-text',
        code: checked.error.code,
        places: checked.error.places.length,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return checked;
    }
    let created = 0;
    for (const seeded of tree) {
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
