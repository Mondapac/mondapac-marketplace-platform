import type { MarketContext } from '@mondapac/shared-kernel';
import { MAX_TREE_NODES } from '../../domain/category-tree';
import type { StoredCategoryNode } from '../../domain/category-tree';
import type { AttributeAdminReader } from '../ports/attribute-admin.reader';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type {
  CategoryAttributeLinkStore,
  StoredLinkFact,
} from '../ports/category-attribute-link.store';
import type { CategoryTreeReader } from '../ports/category-tree.reader';
import { CATEGORY_LINKS_LOAD_MAX, chainOf, effectiveOf } from './category-links';

/**
 * The feature set of a product is the one its primary category holds (attributes plan A4,
 * decision ت۱۰; CAT-10): the nearest category, itself first, that holds one; the Market's default
 * feature set when no category up the chain does, or when the product has no category yet.
 * A tree or link list that cannot be read, a category that is not in the tree, or a feature set
 * that is missing or not `active` is `unavailable`: nothing falls back to the default silently.
 */
export type FamilyResolution =
  | { readonly ok: true; readonly familyCode: string }
  | { readonly ok: false; readonly code: 'family.unavailable' };

export interface ProductFamilyResolverDependencies {
  readonly treeReader: CategoryTreeReader;
  readonly linkStore: CategoryAttributeLinkStore;
  readonly attributeAdminReader: AttributeAdminReader;
  readonly policy: CatalogMarketPolicy;
}

/** One read of the tree and the links, answering for any number of categories. */
export interface FamilyResolutionSession {
  resolve(primaryCategoryId: string | null): Promise<FamilyResolution>;
}

export class ProductFamilyResolver {
  constructor(private readonly deps: ProductFamilyResolverDependencies) {}

  /** Reads the tree and the links once; call inside the open unit of the use case. */
  async open(market: MarketContext): Promise<FamilyResolutionSession> {
    const nodes = await this.deps.treeReader.nodes(market, MAX_TREE_NODES + 1);
    const links = await this.deps.linkStore.all(market, CATEGORY_LINKS_LOAD_MAX + 1);
    const readable = nodes.length <= MAX_TREE_NODES && links.length <= CATEGORY_LINKS_LOAD_MAX;
    const familyCodes = new Map<string, string | null>();
    const codeOf = async (familyId: string): Promise<string | null> => {
      if (!familyCodes.has(familyId)) {
        const family = await this.deps.attributeAdminReader.featureSet(market, familyId as never);
        familyCodes.set(
          familyId,
          family !== null && family.status === 'active' ? family.code : null,
        );
      }
      return familyCodes.get(familyId) ?? null;
    };
    const fallback = (): FamilyResolution => ({
      ok: true,
      familyCode: this.deps.policy.defaultFamily(market),
    });
    return {
      resolve: async (primaryCategoryId): Promise<FamilyResolution> => {
        if (primaryCategoryId === null) return fallback();
        if (!readable) return UNAVAILABLE;
        return resolveIn(nodes, links, primaryCategoryId, codeOf, fallback);
      },
    };
  }

  async resolve(
    market: MarketContext,
    primaryCategoryId: string | null,
  ): Promise<FamilyResolution> {
    return (await this.open(market)).resolve(primaryCategoryId);
  }
}

const UNAVAILABLE: FamilyResolution = { ok: false, code: 'family.unavailable' };

async function resolveIn(
  nodes: readonly StoredCategoryNode[],
  links: readonly StoredLinkFact[],
  categoryId: string,
  codeOf: (familyId: string) => Promise<string | null>,
  fallback: () => FamilyResolution,
): Promise<FamilyResolution> {
  const chain = chainOf(categoryId, nodes);
  if (chain === null) return UNAVAILABLE;
  const effective = effectiveOf(chain, links);
  if (effective.familyId === null) return fallback();
  const code = await codeOf(effective.familyId);
  return code === null ? UNAVAILABLE : { ok: true, familyCode: code };
}
