import type { Id } from '@mondapac/shared-kernel';
import { CATEGORY_SLUG } from './category-edit';
import { MAX_TREE_DEPTH, type LiveCategory, type StoredCategoryNode } from './category-tree';

// The buyer site's view of the platform category tree (categories package C6a; plan decisions 9
// and 11): the live tree with what the menu, the category page and the sitemap need, and the
// resolver behind `/c/{slug}` (slug history and merges answer a permanent redirect, a hidden
// category a temporary one). Pure: the use cases read the store and call these.

/** What the buyer site may show of one category beside the tree row (published content only). */
export interface PublicCategoryDetails {
  /** False keeps the category out of menus; its page and products stay (C3a). */
  readonly showInMenu: boolean;
  /** English only (plan decision 14). */
  readonly seo: {
    readonly title: string | null;
    readonly description: string | null;
    readonly noindex: boolean;
  };
  /** The short description of the published revision, per locale. */
  readonly shortDescriptions: ReadonlyMap<string, string>;
}

/** One category of the public tree. */
export interface PublicCategory extends LiveCategory {
  /** In the asked locale, else in the Market's default locale; null when neither has one. */
  readonly shortDescription: string | null;
  /** The category image. Always null until the image package (C3c) stores one. */
  readonly imageUrl: string | null;
  readonly seo: PublicCategoryDetails['seo'];
  /** The admin's "Show in menu" switch for this category alone. */
  readonly showInMenu: boolean;
  /**
   * A product with a listed Offer is on this category or on a live category below it (plan
   * decision 11). Catalog's own facts only: the seller's may-sell state is not read here.
   */
  readonly hasLiveProducts: boolean;
  /**
   * Shown in menus and the sitemap: its own switch is on, it has live products, and its live
   * parent is in the menu too (a menu cannot show a child without its parent).
   */
  readonly inMenu: boolean;
}

const NO_DETAILS: PublicCategoryDetails = {
  showInMenu: true,
  seo: { title: null, description: null, noindex: false },
  shortDescriptions: new Map(),
};

/**
 * The public tree from the live tree (depth first, as `liveCategoryTree` answers), the details of
 * each category, and the ids of the categories that carry a product with a listed Offer directly.
 * A category without details keeps the defaults (in the menu, no SEO, no description).
 */
export function publicCategoryTree(
  live: readonly LiveCategory[],
  details: ReadonlyMap<Id<'Category'>, PublicCategoryDetails>,
  withLiveProducts: ReadonlySet<Id<'Category'>>,
  locale: string,
  defaultLocale: string,
): readonly PublicCategory[] {
  // Depth first puts every child after its parent: walking backwards reaches all of a node's
  // children before the node, so "has live products" folds up in one pass.
  const hasLive = new Set<Id<'Category'>>();
  for (let index = live.length - 1; index >= 0; index -= 1) {
    const node = live[index]!;
    if (withLiveProducts.has(node.id) || hasLive.has(node.id)) {
      hasLive.add(node.id);
      if (node.parentId !== null) hasLive.add(node.parentId);
    }
  }
  const inMenu = new Set<Id<'Category'>>();
  return live.map((node) => {
    const own = details.get(node.id) ?? NO_DETAILS;
    const parentInMenu = node.parentId === null || inMenu.has(node.parentId);
    const shown = own.showInMenu && hasLive.has(node.id) && parentInMenu;
    if (shown) inMenu.add(node.id);
    return {
      ...node,
      shortDescription:
        own.shortDescriptions.get(locale) ?? own.shortDescriptions.get(defaultLocale) ?? null,
      imageUrl: null,
      seo: own.seo,
      showInMenu: own.showInMenu,
      hasLiveProducts: hasLive.has(node.id),
      inMenu: shown,
    };
  });
}

/** Where a slug leads (catalog.category-slug-resolve). */
export type CategorySlugResolution =
  | { readonly kind: 'category'; readonly id: Id<'Category'>; readonly slug: string }
  /**
   * Another slug answers the page: `permanent` when every step was a retired slug, a merge or an
   * archive (301); false when a hidden category was passed on the way (302). Always one hop: a
   * chain is followed to its end here, so the buyer site never redirects twice.
   */
  | { readonly kind: 'redirect'; readonly slug: string; readonly permanent: boolean }
  | { readonly kind: 'not-found' };

const NOT_FOUND: CategorySlugResolution = { kind: 'not-found' };

/**
 * Resolves the slug of a `/c/{slug}` path (pure). `nodes` is every platform category of the
 * Market (any status); `liveIds` the categories of the live tree (shown on the site); `historyOf`
 * answers the category that last retired a slug, or null.
 *
 * A category holding the slug now is taken first (a retired slug is not reused for 12 months, and
 * a merged or archived row keeps its slug); else the slug history. From there: a live category is
 * the answer (a redirect to its slug when reached by any step); a merged one is followed to the
 * category it was merged into, an archived one to its parent (both permanent); a hidden one, or an
 * active one inside a hidden branch, to its parent, and the redirect becomes temporary. A loop, a
 * missing id, a chain longer than the tree is deep, a target slug that is not a slug, or a target
 * equal to the asked slug is not-found: never a redirect that could loop or leave the site.
 */
export function resolveCategorySlug(
  slug: string,
  nodes: readonly StoredCategoryNode[],
  liveIds: ReadonlySet<Id<'Category'>>,
  historyOf: (slug: string) => Id<'Category'> | null,
): CategorySlugResolution {
  if (!CATEGORY_SLUG.test(slug)) return NOT_FOUND;
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const holder = nodes.find((node) => node.slug === slug);
  let moved = holder === undefined;
  let next: Id<'Category'> | null = holder?.id ?? historyOf(slug);
  let permanent = true;
  const seen = new Set<Id<'Category'>>();
  while (next !== null) {
    if (seen.has(next) || seen.size > MAX_TREE_DEPTH * 2) return NOT_FOUND;
    seen.add(next);
    const node = byId.get(next);
    if (node === undefined) return NOT_FOUND;
    if (node.status === 'active' && liveIds.has(node.id)) {
      if (!moved) return { kind: 'category', id: node.id, slug: node.slug };
      if (!CATEGORY_SLUG.test(node.slug) || node.slug === slug) return NOT_FOUND;
      return { kind: 'redirect', slug: node.slug, permanent };
    }
    moved = true;
    if (node.status === 'merged') {
      next = node.mergedIntoId;
      if (next === null) return NOT_FOUND;
    } else {
      // Archived (permanent), hidden, or active but not live (under a hidden ancestor, or with
      // no name): the parent is the nearest place left to send the buyer.
      if (node.status !== 'archived') permanent = false;
      next = node.parentId;
    }
  }
  return NOT_FOUND;
}
