import { Logger } from '@nestjs/common';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_CATEGORY_TREE_EDIT } from '../../contracts/permissions';
import { MAX_TREE_NODES } from '../../domain/category-tree';
import {
  isEditable,
  parseCategorySeo,
  parseCategoryTexts,
  siblingNameClashes,
} from '../../domain/category-edit';
import { PlatformCategoryDetailsChangedAudit } from '../../domain/audit';
import {
  announceChanged,
  categoryIdOf,
  checkedPlaces,
  closedInput,
  editorAccountOf,
  invalid,
  refuseClaimTexts,
  requiredCategoryLocales,
  versionOf,
  type CategoryWriteDependencies,
  type CategoryWriteFailure,
  type CategoryWriteView,
} from '../categories/category-editor';

export interface CategoryEditDetailsInput {
  readonly [key: string]: unknown;
}

const KEYS = ['categoryId', 'version', 'texts', 'seo', 'showInMenu', 'imageId'] as const;

/**
 * `platform-category.edit-details` (categories package C3a): an admin replaces the details of an
 * active or hidden category: a name, short description and keywords per locale, the English-only
 * search-result fields and the menu flag. The request is the whole content (a field left out is
 * cleared) and the category version the admin saw; a later version is `conflict.stale`. It makes
 * a new revision and announces the change; a save that changes nothing writes nothing. The slug
 * has its own use case. The category image waits for the image intake of purpose `category-image`:
 * a non-null `imageId` is refused (`unsupported`). Rule: the key `catalog.category-tree.edit`.
 * Not a structural change: it does not raise the tree version.
 */
export class CategoryEditDetails extends UseCase<
  CategoryEditDetailsInput,
  { readonly category: CategoryWriteView },
  CategoryWriteFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-edit-details',
    rule: { kind: 'permissions', allOf: [CATALOG_CATEGORY_TREE_EDIT.key] },
  };

  readonly #logger = new Logger('CategoryEditDetails');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryWriteDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CategoryEditDetailsInput,
  ): Promise<Result<{ readonly category: CategoryWriteView }, CategoryWriteFailure>> {
    const result = await this.#edit(context, input);
    this.#logger.log({
      msg: 'catalog.category-edit-details',
      code: result.ok ? 'edited' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #edit(
    context: CallContext,
    input: CategoryEditDetailsInput,
  ): Promise<Result<{ readonly category: CategoryWriteView }, CategoryWriteFailure>> {
    const accountId = editorAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, KEYS);
    if (!body.ok) return body;
    const id = categoryIdOf(body.value['categoryId']);
    if (!id.ok) return err({ code: 'category.not-found' });
    const version = versionOf(body.value['version'], 'version');
    if (!version.ok) return version;
    const showInMenu = body.value['showInMenu'] ?? true;
    if (typeof showInMenu !== 'boolean') return invalid('showInMenu', 'type');
    const imageId = body.value['imageId'];
    if (imageId !== undefined && imageId !== null) return invalid('imageId', 'unsupported');
    const { market } = context;
    const { policy, store, ids, clock } = this.deps;
    let locales: { readonly default: string; readonly supported: readonly string[] };
    let required: readonly string[];
    try {
      locales = policy.locales(market);
      required = requiredCategoryLocales(market, policy);
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
      checkedPlaces({ texts: texts.value, seo: seo.value, defaultLocale: locales.default }),
    );
    if (claim !== null) return err(claim);

    try {
      return await this.deps.unitOfWork.run<
        { readonly category: CategoryWriteView },
        CategoryWriteFailure
      >(market, async () => {
        const nodes = await store.loadAll(market, MAX_TREE_NODES + 1);
        if (nodes.length > MAX_TREE_NODES) return err({ code: 'access.unavailable' } as const);
        const target = nodes.find((node) => node.id === id.value);
        if (target === undefined) return err({ code: 'category.not-found' } as const);
        if (!isEditable(target.status)) return err({ code: 'category.not-editable' } as const);
        if (target.version !== version.value) return err({ code: 'conflict.stale' } as const);
        const clashes = siblingNameClashes(nodes, target.parentId, target.id, texts.value);
        if (clashes.length > 0) {
          return err({ code: 'category.sibling-name-taken', fields: clashes } as const);
        }
        const treeVersion = (await this.deps.categories.treeVersion(market)).version;
        const unchanged =
          JSON.stringify(target.texts) === JSON.stringify(texts.value) &&
          JSON.stringify(target.seo) === JSON.stringify(seo.value) &&
          target.showInMenu === showInMenu;
        if (unchanged) {
          return ok({
            category: {
              id: target.id,
              slug: target.slug,
              status: target.status,
              version: target.version,
              revisionNo: target.revisionNo,
              treeVersion,
            },
          });
        }
        const newVersion = await store.apply(market, {
          category: target,
          revisionId: ids.next<'CategoryRevision'>(),
          kind: 'details-changed',
          texts: texts.value,
          patch: { seo: seo.value, showInMenu },
          authorAccountId: accountId,
          now: clock.now(),
        });
        await this.deps.audit.record(
          context,
          PlatformCategoryDetailsChangedAudit.entry(target.id, {
            before: { revisionNo: target.revisionNo, localeCount: target.texts.length },
            after: {
              revisionNo: target.revisionNo + 1,
              localeCount: texts.value.length,
              showInMenu,
              noindex: seo.value.noindex,
            },
          }),
        );
        await announceChanged(this.deps, context, target.id, newVersion);
        return ok({
          category: {
            id: target.id,
            slug: target.slug,
            status: target.status,
            version: newVersion,
            revisionNo: target.revisionNo + 1,
            treeVersion,
          },
        });
      });
    } catch (error) {
      if (error instanceof StaleAggregateError) return err({ code: 'conflict.stale' });
      throw error;
    }
  }
}
