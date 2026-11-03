import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_CATEGORY_TREE_EDIT } from '../../contracts/permissions';
import { PlatformCategorySlugChangedAudit } from '../../domain/audit';
import { isCategorySlug, isEditable } from '../../domain/category-edit';
import {
  announceChanged,
  categoryIdOf,
  closedInput,
  editorAccountOf,
  checkedPlaces,
  invalid,
  refuseClaimTexts,
  runStructural,
  versionOf,
  type CategoryWriteDependencies,
  type CategoryWriteFailure,
  type CategoryWriteView,
} from '../categories/category-editor';

export interface CategoryChangeSlugInput {
  readonly [key: string]: unknown;
}

const KEYS = ['categoryId', 'slug', 'treeVersion'] as const;

/**
 * `platform-category.change-slug` (categories package C3a; plan section 8): an admin changes the
 * URL name of a category. The old slug goes into the slug history in the same unit, so the shop
 * can redirect it (301) to the new address, and no other category may take it for 12 months. The
 * new slug is unique in the Market, is not retired from another category in the last 12 months,
 * and passes the claim-text check (it is shown in the address). Rule: the key
 * `catalog.category-tree.edit`.
 */
export class CategoryChangeSlug extends UseCase<
  CategoryChangeSlugInput,
  { readonly category: CategoryWriteView },
  CategoryWriteFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-change-slug',
    rule: { kind: 'permissions', allOf: [CATALOG_CATEGORY_TREE_EDIT.key] },
  };

  readonly #logger = new Logger('CategoryChangeSlug');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryWriteDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CategoryChangeSlugInput,
  ): Promise<Result<{ readonly category: CategoryWriteView }, CategoryWriteFailure>> {
    const result = await this.#run(context, input);
    this.#logger.log({
      msg: 'catalog.category-change-slug',
      code: result.ok ? 'slug-changed' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #run(
    context: CallContext,
    input: CategoryChangeSlugInput,
  ): Promise<Result<{ readonly category: CategoryWriteView }, CategoryWriteFailure>> {
    const accountId = editorAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, KEYS);
    if (!body.ok) return body;
    const id = categoryIdOf(body.value['categoryId']);
    if (!id.ok) return err({ code: 'category.not-found' });
    const treeVersion = versionOf(body.value['treeVersion'], 'treeVersion');
    if (!treeVersion.ok) return treeVersion;
    const { market } = context;
    const { store, ids, clock } = this.deps;
    const slug = body.value['slug'];
    if (!isCategorySlug(slug)) return invalid('slug', 'format');
    let defaultLocale: string;
    try {
      defaultLocale = this.deps.policy.locales(market).default;
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const claim = await refuseClaimTexts(
      this.deps,
      context,
      checkedPlaces({ slug, defaultLocale }),
    );
    if (claim !== null) return err(claim);
    return runStructural(this.deps, market, treeVersion.value, async (nodes, nextTreeVersion) => {
      const target = nodes.find((node) => node.id === id.value);
      if (target === undefined) return err({ code: 'category.not-found' } as const);
      if (!isEditable(target.status)) return err({ code: 'category.not-editable' } as const);
      if (target.slug === slug) return err({ code: 'category.slug-unchanged' } as const);
      if (await store.slugUnavailable(market, slug, target.id, clock.now())) {
        return err({ code: 'category.slug-taken' } as const);
      }
      const at = clock.now();
      await store.retireSlug(market, target.id, target.slug, at);
      const version = await store.apply(market, {
        category: target,
        revisionId: ids.next<'CategoryRevision'>(),
        kind: 'slug-changed',
        texts: target.texts,
        patch: { slug },
        authorAccountId: accountId,
        now: at,
      });
      await this.deps.audit.record(
        context,
        PlatformCategorySlugChangedAudit.entry(target.id, {
          before: { revisionNo: target.revisionNo },
          after: { revisionNo: target.revisionNo + 1 },
        }),
      );
      await announceChanged(this.deps, context, target.id, version);
      return ok({
        category: {
          id: target.id,
          slug,
          status: target.status,
          version,
          revisionNo: target.revisionNo + 1,
          treeVersion: nextTreeVersion,
        },
      });
    });
  }
}
