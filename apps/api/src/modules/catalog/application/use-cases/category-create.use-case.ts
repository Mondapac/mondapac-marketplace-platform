import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_CATEGORY_TREE_EDIT } from '../../contracts/permissions';
import {
  isCategorySlug,
  isEditable,
  levelOf,
  parseCategorySeo,
  parseCategoryTexts,
  siblingNameClashes,
} from '../../domain/category-edit';
import { PlatformCategoryCreatedAudit } from '../../domain/audit';
import { PlatformCategoryCreated } from '../../domain/events';
import {
  categoryIdOf,
  checkedPlaces,
  closedInput,
  editorAccountOf,
  invalid,
  refuseClaimTexts,
  requiredCategoryLocales,
  runStructural,
  versionOf,
  type CategoryWriteDependencies,
  type CategoryWriteFailure,
  type CategoryWriteView,
} from '../categories/category-editor';

export interface CategoryCreateInput {
  readonly [key: string]: unknown;
}

const KEYS = ['parentId', 'slug', 'texts', 'seo', 'showInMenu', 'treeVersion'] as const;

/**
 * `platform-category.create` (categories package C3a; plan decision 5): an admin adds a category
 * or a child. It is created `hidden`, last among its siblings, and goes live with Show. The slug
 * is the one given: unique in the Market, not retired from another category in the last 12
 * months; the level may not pass the Market's `maxCategoryDepth`; two siblings may not share a
 * name in a locale. The default locale's name is required; every text passes the claim-text
 * check in its own locale and a locale the check cannot read is refused (fail closed). A
 * structural write: it names the tree version the page read. Rule: the key
 * `catalog.category-tree.edit`, the admin population, never an acting-as session.
 */
export class CategoryCreate extends UseCase<
  CategoryCreateInput,
  { readonly category: CategoryWriteView },
  CategoryWriteFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-create',
    rule: { kind: 'permissions', allOf: [CATALOG_CATEGORY_TREE_EDIT.key] },
  };

  readonly #logger = new Logger('CategoryCreate');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryWriteDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CategoryCreateInput,
  ): Promise<Result<{ readonly category: CategoryWriteView }, CategoryWriteFailure>> {
    const result = await this.#create(context, input);
    this.#logger.log({
      msg: 'catalog.category-create',
      code: result.ok ? 'created' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #create(
    context: CallContext,
    input: CategoryCreateInput,
  ): Promise<Result<{ readonly category: CategoryWriteView }, CategoryWriteFailure>> {
    const accountId = editorAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, KEYS);
    if (!body.ok) return body;
    const { market } = context;
    const { policy, store, ids, clock } = this.deps;

    const rawParent = body.value['parentId'];
    let parentId: Id<'Category'> | null = null;
    if (rawParent !== undefined && rawParent !== null) {
      const parsed = categoryIdOf(rawParent);
      if (!parsed.ok) return err({ code: 'category.parent-not-found' });
      parentId = parsed.value;
    }
    const slug = body.value['slug'];
    if (!isCategorySlug(slug)) return invalid('slug', 'format');
    const treeVersion = versionOf(body.value['treeVersion'], 'treeVersion');
    if (!treeVersion.ok) return treeVersion;
    const showInMenu = body.value['showInMenu'] ?? true;
    if (typeof showInMenu !== 'boolean') return invalid('showInMenu', 'type');

    let locales: { readonly default: string; readonly supported: readonly string[] };
    let required: readonly string[];
    let maxDepth: number;
    try {
      locales = policy.locales(market);
      required = requiredCategoryLocales(market, policy);
      maxDepth = policy.maxCategoryDepth(market);
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const texts = parseCategoryTexts(body.value['texts'], {
      supported: locales.supported,
      required,
    });
    if (!texts.ok) return texts;
    const seo = parseCategorySeo(body.value['seo']);
    if (!seo.ok) return seo;

    const claim = await refuseClaimTexts(
      this.deps,
      context,
      checkedPlaces({
        texts: texts.value,
        seo: seo.value,
        slug,
        defaultLocale: locales.default,
      }),
    );
    if (claim !== null) return err(claim);

    return runStructural(this.deps, market, treeVersion.value, async (nodes, nextTreeVersion) => {
      const byId = new Map(nodes.map((node) => [node.id as string, node] as const));
      if (parentId !== null) {
        const parent = byId.get(parentId);
        if (parent === undefined || !isEditable(parent.status)) {
          return err({ code: 'category.parent-not-found' } as const);
        }
      }
      if (levelOf(byId, parentId) + 1 > maxDepth) {
        return err({ code: 'category.depth-exceeded', max: maxDepth } as const);
      }
      if (await store.slugUnavailable(market, slug, null, clock.now())) {
        return err({ code: 'category.slug-taken' } as const);
      }
      const clashes = siblingNameClashes(nodes, parentId, null, texts.value);
      if (clashes.length > 0) {
        return err({ code: 'category.sibling-name-taken', fields: clashes } as const);
      }
      const now = clock.now();
      const id = ids.next<'Category'>();
      await store.insert(market, {
        id,
        revisionId: ids.next<'CategoryRevision'>(),
        parentId,
        slug,
        texts: texts.value,
        seo: seo.value,
        showInMenu,
        authorAccountId: accountId,
        now,
      });
      await this.deps.audit.record(
        context,
        PlatformCategoryCreatedAudit.entry(id, {
          after: {
            status: 'hidden',
            level: levelOf(byId, parentId) + 1,
            localeCount: texts.value.length,
          },
        }),
      );
      await this.deps.outbox.append(context, [
        PlatformCategoryCreated.record({
          aggregateId: id,
          aggregateVersion: 1,
          occurredAt: now,
          payload: { categoryId: id },
        }),
      ]);
      return ok({
        category: {
          id,
          slug,
          status: 'hidden',
          version: 1,
          revisionNo: 1,
          treeVersion: nextTreeVersion,
        },
      });
    });
  }
}
