import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { AttributeDataType, CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_ATTRIBUTE_VIEW } from '../../contracts/permissions';
import type { LocalizedText } from '../../domain/attribute-definition';
import type {
  CategoryAttributeLink,
  EffectiveAttributes,
} from '../../domain/category-attribute-link';
import { MAX_TREE_NODES } from '../../domain/category-tree';
import { ATTRIBUTE_LOAD_MAX } from '../attributes/attribute-admin-views';
import {
  CATEGORY_LINKS_LOAD_MAX,
  categoryIdOf,
  chainOf,
  effectiveOf,
} from '../attributes/category-links';
import type {
  AttributeAdminReader,
  AttributeDefinitionRecord,
  FeatureSetRecord,
} from '../ports/attribute-admin.reader';
import type { CategoryAttributeLinkStore } from '../ports/category-attribute-link.store';
import type { CategoryTreeReader } from '../ports/category-tree.reader';

export interface CategoryAttributeLinksGetInput {
  readonly categoryId: unknown;
}

export interface CategoryLinkFilterView {
  readonly code: string;
  /** The category that lists it: this one or the nearest ancestor that does. */
  readonly fromCategoryId: string;
  readonly inherited: boolean;
  readonly names: LocalizedText | null;
  readonly dataType: AttributeDataType | null;
  readonly status: string | null;
}

export interface CategoryAttributeLinksGetOutput {
  readonly categoryId: string;
  /** What this category holds itself; null when nobody has set it. */
  readonly own: {
    readonly featureSetId: string | null;
    readonly filters: readonly string[];
    readonly revisionNo: number;
    /** The version the editor names when it saves. */
    readonly version: number;
  } | null;
  readonly effective: {
    readonly featureSet: {
      readonly id: string;
      readonly code: string;
      readonly names: LocalizedText;
      readonly fromCategoryId: string;
      readonly inherited: boolean;
    } | null;
    readonly filters: readonly CategoryLinkFilterView[];
  };
}

type LinksRead =
  | 'unavailable'
  | 'not-found'
  | {
      readonly own: CategoryAttributeLink | null;
      readonly effective: EffectiveAttributes;
      readonly family: FeatureSetRecord | null;
      readonly definitions: readonly AttributeDefinitionRecord[];
    };

export type CategoryAttributeLinksGetFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'category.not-found' };

export interface CategoryAttributeLinksGetDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly linkStore: CategoryAttributeLinkStore;
  readonly treeReader: CategoryTreeReader;
  readonly attributeAdminReader: AttributeAdminReader;
}

/**
 * `category-attribute-links.get` (attributes package A4; categories C8): what a category holds
 * itself and what it ends up with after inheritance: the feature set of the nearest category,
 * itself first, that holds one, and the filters of every category from the root down. A tree that
 * cannot be read is `access.unavailable`, never a partial answer. Rule: `catalog.attribute.view`
 * and the admin population.
 */
export class CategoryAttributeLinksGet extends UseCase<
  CategoryAttributeLinksGetInput,
  CategoryAttributeLinksGetOutput,
  CategoryAttributeLinksGetFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-attribute-links-get',
    rule: { kind: 'permissions', allOf: [CATALOG_ATTRIBUTE_VIEW.key] },
  };

  readonly #logger = new Logger('CategoryAttributeLinksGet');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryAttributeLinksGetDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CategoryAttributeLinksGetInput,
  ): Promise<Result<CategoryAttributeLinksGetOutput, CategoryAttributeLinksGetFailure>> {
    const result = await this.#get(context, input);
    this.#logger.log({
      msg: 'catalog.category-attribute-links-get',
      code: result.ok ? 'read' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #get(
    context: CallContext,
    input: CategoryAttributeLinksGetInput,
  ): Promise<Result<CategoryAttributeLinksGetOutput, CategoryAttributeLinksGetFailure>> {
    if (context.actor.kind !== 'authenticated' || context.actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const categoryId = categoryIdOf(input?.categoryId);
    if (categoryId === null) return err({ code: 'category.not-found' });
    const { market } = context;
    const reader = this.deps.attributeAdminReader;
    const read = await this.deps.unitOfWork.run<LinksRead, never>(
      market,
      async (): Promise<Result<LinksRead, never>> => {
        const nodes = await this.deps.treeReader.nodes(market, MAX_TREE_NODES + 1);
        if (nodes.length > MAX_TREE_NODES) return ok('unavailable' as const);
        if (!nodes.some((node) => node.id === categoryId)) return ok('not-found' as const);
        const chain = chainOf(categoryId, nodes);
        if (chain === null) return ok('unavailable' as const);
        const links = await this.deps.linkStore.all(market, CATEGORY_LINKS_LOAD_MAX + 1);
        if (links.length > CATEGORY_LINKS_LOAD_MAX) return ok('unavailable' as const);
        const own = await this.deps.linkStore.find(market, categoryId);
        const effective = effectiveOf(chain, links, own);
        const family =
          effective.familyId === null ? null : await reader.featureSet(market, effective.familyId);
        const definitions = await reader.definitions(market, ATTRIBUTE_LOAD_MAX);
        return ok({ own, effective, family, definitions });
      },
      { readOnly: true },
    );
    if (!read.ok || read.value === 'unavailable') return err({ code: 'access.unavailable' });
    if (read.value === 'not-found') return err({ code: 'category.not-found' });
    const { own, effective, family, definitions } = read.value;
    const byCode = new Map(definitions.map((definition) => [definition.code, definition]));
    return ok({
      categoryId,
      own:
        own === null
          ? null
          : {
              featureSetId: own.state.familyId,
              filters: [...own.state.filters],
              revisionNo: own.state.revisionNo,
              version: own.state.version,
            },
      effective: {
        featureSet:
          family === null || effective.familyFromCategoryId === null
            ? null
            : {
                id: family.id,
                code: family.code,
                names: { ...family.names },
                fromCategoryId: effective.familyFromCategoryId,
                inherited: effective.familyFromCategoryId !== categoryId,
              },
        filters: effective.filters.map((filter) => {
          const definition = byCode.get(filter.code);
          return {
            code: filter.code,
            fromCategoryId: filter.fromCategoryId,
            inherited: filter.fromCategoryId !== categoryId,
            names: definition === undefined ? null : { ...definition.revision.names },
            dataType: definition?.dataType ?? null,
            status: definition?.status ?? null,
          };
        }),
      },
    });
  }
}
