import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_CATEGORY_TREE_EDIT } from '../../contracts/permissions';
import { PlatformCategoryShownAudit } from '../../domain/audit';
import { planShow } from '../../domain/category-edit';
import {
  announceChanged,
  categoryIdOf,
  closedInput,
  editorAccountOf,
  requiredCategoryLocales,
  runStructural,
  versionOf,
  type CategoryWriteDependencies,
  type CategoryWriteFailure,
  type CategoryWriteView,
} from '../categories/category-editor';

export interface CategoryShowInput {
  readonly [key: string]: unknown;
}

const KEYS = ['categoryId', 'treeVersion'] as const;

/**
 * `platform-category.show` (categories package C3a): an admin shows a hidden category, which is
 * how a newly added category goes live (plan decision 5). It needs a name in every required
 * locale, and its parent must be active. Descendants that this category's Hide hid come back
 * with it; ones hidden on their own do not. Every node gets a `shown` revision and an event.
 * A category hidden by an ancestor's Hide is shown by showing that ancestor
 * (`category.parent-hidden`). Rule: the key `catalog.category-tree.edit`.
 */
export class CategoryShow extends UseCase<
  CategoryShowInput,
  { readonly category: CategoryWriteView },
  CategoryWriteFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-show',
    rule: { kind: 'permissions', allOf: [CATALOG_CATEGORY_TREE_EDIT.key] },
  };

  readonly #logger = new Logger('CategoryShow');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryWriteDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CategoryShowInput,
  ): Promise<Result<{ readonly category: CategoryWriteView }, CategoryWriteFailure>> {
    const result = await this.#run(context, input);
    this.#logger.log({
      msg: 'catalog.category-show',
      code: result.ok ? 'shown' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #run(
    context: CallContext,
    input: CategoryShowInput,
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
    let required: readonly string[];
    try {
      required = requiredCategoryLocales(market, this.deps.policy);
    } catch {
      return err({ code: 'access.unavailable' });
    }
    return runStructural(this.deps, market, treeVersion.value, async (nodes, nextTreeVersion) => {
      const target = nodes.find((node) => node.id === id.value);
      if (target === undefined) return err({ code: 'category.not-found' } as const);
      const missing = required
        .filter((locale) => !target.texts.some((text) => text.locale === locale))
        .map((locale) => ({ path: `texts.${locale}.name`, code: 'required' }));
      if (missing.length > 0) {
        return err({ code: 'category.required-locale-missing', fields: missing } as const);
      }
      const plan = planShow(nodes, target);
      if (!plan.ok) return plan;
      const at = clock.now();
      let version = target.version;
      for (const change of plan.value) {
        const node = nodes.find((entry) => entry.id === change.id)!;
        const newVersion = await store.apply(market, {
          category: node,
          revisionId: ids.next<'CategoryRevision'>(),
          kind: 'shown',
          texts: node.texts,
          patch: { status: change.status, hiddenById: change.hiddenById },
          authorAccountId: accountId,
          now: at,
        });
        if (node.id === target.id) version = newVersion;
        await announceChanged(this.deps, context, node.id, newVersion);
      }
      await this.deps.audit.record(
        context,
        PlatformCategoryShownAudit.entry(target.id, {
          before: { status: 'hidden' },
          after: { status: 'active', restored: plan.value.length - 1 },
        }),
      );
      return ok({
        category: {
          id: target.id,
          slug: target.slug,
          status: 'active',
          version,
          revisionNo: target.revisionNo + 1,
          treeVersion: nextTreeVersion,
        },
      });
    });
  }
}
