import { Logger } from '@nestjs/common';
import { ok } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import { impactItem, type ChangeImpact } from '../../system-requests';
import { categoryImpact } from '../domain/category-admin-tree';
import { MAX_TREE_NODES } from '../domain/category-tree';
import { attributeIdOf, editorAccountOf as attributeEditorOf } from './attributes/attribute-editor';
import { categoryIdOf, editorAccountOf as categoryEditorOf } from './categories/category-editor';
import type { AccessDeclaration, AuthorisationCheck } from '../../../platform/authz';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type { AdminCategoryReader } from './ports/admin-category.reader';
import type { AttributeDefinitionStore } from './ports/attribute-definition.store';
import type { AttributeImpactReader } from './ports/attribute-impact.reader';
import type { CategoryProductMoveStore } from './ports/category-product-move.store';
import { AttributeImpactGet } from './use-cases/attribute-impact-get.use-case';
import { CategoryImpact } from './use-cases/category-impact.use-case';

// The impact counts of the catalogue requests that wait for approval (Admin Inbox › System
// requests, the request's detail page): how many products and Offers a discard, merge, archive or
// products move of a category reaches, and what an attribute's discard, archive, merge or merge of
// values reaches. The same reads as the admin's own impact dialogs (`platform-category.impact`,
// `attribute-definition.impact`), each behind its read rule for the viewing admin (fail closed:
// no impact), in a read-only unit of the request's Market (the viewer's context). Counts only,
// never a name. Advisory: the approval's apply checks everything again.

/** The time bound of the product facts read here: inside System requests' own wait. */
export const IMPACT_FACTS_BUDGET_MS = 2_000;

const logger = new Logger('CatalogueImpact');

/** The reads behind the impact counts (a subset of the appliers' dependencies). */
export interface CatalogueImpactDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly authorisation: AuthorisationCheck;
  readonly adminCategoryReader: Pick<AdminCategoryReader, 'categories' | 'productFacts'>;
  readonly moveStore: Pick<CategoryProductMoveStore, 'countProducts'>;
  readonly attributeStore: Pick<AttributeDefinitionStore, 'findById'>;
  readonly impact: AttributeImpactReader;
}

type ImpactDependencies = CatalogueImpactDependencies;

/** Whether the viewing admin holds the read's key (a throw is caught by `orNone`: no impact). */
const mayRead = async (
  deps: ImpactDependencies,
  context: CallContext,
  access: AccessDeclaration,
): Promise<boolean> => (await deps.authorisation.check(context, access)).allowed;

async function orNone(
  context: CallContext,
  kind: string,
  read: () => Promise<ChangeImpact | null>,
): Promise<ChangeImpact | null> {
  try {
    return await read();
  } catch (error) {
    logger.warn({
      msg: 'catalog.request-impact-unavailable',
      subject: kind,
      error: error instanceof Error ? error.name : 'unknown',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return null;
  }
}

/**
 * A category's subtree (a discard, merge or archive): published products under it, their Offers,
 * those with an active certification tag (which a merge or archive re-checks) and the categories
 * under it. Needs the viewer to hold `platform-category.impact`'s read key.
 */
export function categoryRequestImpact(
  deps: ImpactDependencies,
  context: CallContext,
  subjectRef: string,
  signal?: AbortSignal,
): Promise<ChangeImpact | null> {
  return orNone(context, 'category', async () => {
    if (categoryEditorOf(context) === null) return null;
    const id = categoryIdOf(subjectRef);
    if (!id.ok) return null;
    if (!(await mayRead(deps, context, CategoryImpact.access))) return null;
    // System requests stopped waiting: start no read.
    if (signal?.aborted === true) return null;
    const { market } = context;
    const read = await deps.unitOfWork.run(
      market,
      async () => {
        const nodes = await deps.adminCategoryReader.categories(market, MAX_TREE_NODES + 1);
        if (nodes.length > MAX_TREE_NODES || !nodes.some((node) => node.id === id.value)) {
          return ok(null);
        }
        const counted = await deps.adminCategoryReader.productFacts(market, IMPACT_FACTS_BUDGET_MS);
        return ok({ nodes, counted });
      },
      { readOnly: true },
    );
    if (!read.ok || read.value === null) return null;
    const { nodes, counted } = read.value;
    const counts = categoryImpact(nodes, id.value, counted.facts);
    const partial = !counted.complete;
    return {
      items: [
        impactItem('products', counts.products, partial),
        impactItem('offers', counts.offers, partial),
        impactItem('offers-with-active-tag', counts.offersWithActiveTag, partial),
        impactItem('subcategories', counts.descendants),
      ],
    };
  });
}

/**
 * A move of a category's products: the published products that name the category itself (the
 * move's own count). Needs the viewer to hold `platform-category.impact`'s read key.
 */
export function productsMoveRequestImpact(
  deps: ImpactDependencies,
  context: CallContext,
  subjectRef: string,
  signal?: AbortSignal,
): Promise<ChangeImpact | null> {
  return orNone(context, 'category-products', async () => {
    if (categoryEditorOf(context) === null) return null;
    const id = categoryIdOf(subjectRef);
    if (!id.ok) return null;
    if (!(await mayRead(deps, context, CategoryImpact.access))) return null;
    // System requests stopped waiting: start no read.
    if (signal?.aborted === true) return null;
    const { market } = context;
    const read = await deps.unitOfWork.run(
      market,
      async () => {
        const nodes = await deps.adminCategoryReader.categories(market, MAX_TREE_NODES + 1);
        if (nodes.length > MAX_TREE_NODES || !nodes.some((node) => node.id === id.value)) {
          return ok(null);
        }
        return ok(await deps.moveStore.countProducts(market, id.value));
      },
      { readOnly: true },
    );
    if (!read.ok || read.value === null) return null;
    return { items: [impactItem('products', read.value)] };
  });
}

/**
 * An attribute's discard, archive, merge or merge of values: what `attribute-definition.impact`
 * shows (published products and drafts carrying it, active feature sets listing it, the categories
 * those reach, the categories filtering on it and, for a variant option, the products with live
 * variants). Needs the viewer to hold that read's key.
 */
export function attributeRequestImpact(
  deps: ImpactDependencies,
  context: CallContext,
  subjectRef: string,
  signal?: AbortSignal,
): Promise<ChangeImpact | null> {
  return orNone(context, 'attribute', async () => {
    if (attributeEditorOf(context) === null) return null;
    const id = attributeIdOf(subjectRef);
    if (id === null) return null;
    if (!(await mayRead(deps, context, AttributeImpactGet.access))) return null;
    // System requests stopped waiting: start no read.
    if (signal?.aborted === true) return null;
    const { market } = context;
    const read = await deps.unitOfWork.run(
      market,
      async () => {
        const definition = await deps.attributeStore.findById(market, id);
        if (definition === null) return ok(null);
        const impact = await deps.impact.impactOf(market, {
          code: definition.state.code,
          isVariantOption: definition.state.isVariantOption,
        });
        return ok({ impact, variant: definition.state.isVariantOption });
      },
      { readOnly: true },
    );
    if (!read.ok || read.value === null) return null;
    const { impact, variant } = read.value;
    return {
      items: [
        impactItem('products', impact.publishedProducts.count, impact.publishedProducts.atLeast),
        impactItem('drafts', impact.drafts.count, impact.drafts.atLeast),
        impactItem('feature-sets', impact.featureSetCount),
        impactItem('categories', impact.categories.count, impact.categories.atLeast),
        impactItem('filters', impact.filters.count, impact.filters.atLeast),
        ...(variant
          ? [
              impactItem(
                'variant-products',
                impact.liveVariantProducts.count,
                impact.liveVariantProducts.atLeast,
              ),
            ]
          : []),
      ],
    };
  });
}
