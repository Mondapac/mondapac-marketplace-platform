import { levelOf, LOWEST_PRODUCT_CATEGORY_LEVEL } from './product-category-rules';

/** One stored category as the picker reads it (any status, names of its published revision). */
export interface PickerNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly status: string;
  readonly position: number;
  readonly names: readonly { readonly locale: string; readonly name: string }[];
}

/**
 * One choice of the product forms' category picker (categories package C5a). `path` is the names
 * from the department down to the choice. A level-3 node that has choices under it is listed
 * after them with `general: true`: the product sits on the node itself, not on a child.
 */
export interface PickerChoice {
  readonly id: string;
  readonly level: number;
  readonly name: string;
  readonly path: readonly string[];
  readonly general: boolean;
  readonly status: 'active' | 'hidden';
}

function nameOf(node: PickerNode, locale: string): string {
  const exact = node.names.find((entry) => entry.locale === locale);
  return (exact ?? node.names[0])?.name ?? '';
}

/**
 * The category picker read (plan section 8; amendments C5): levels 3 and `maxLevel` only; children
 * first and the level-3 node itself last as "General" when it has children. A hidden node, and
 * anything under a hidden node, is offered to an admin only (`includeHidden`); a seller never sees
 * them, so an active child under a hidden parent (the seed can create one) is left out too.
 * Merged and archived nodes are never offered. Siblings follow `position`, then id.
 */
export function categoryPicker(
  nodes: readonly PickerNode[],
  locale: string,
  maxLevel: number,
  includeHidden: boolean,
): readonly PickerChoice[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string | null, PickerNode[]>();
  for (const node of nodes) {
    const list = children.get(node.parentId) ?? [];
    list.push(node);
    children.set(node.parentId, list);
  }
  for (const list of children.values()) {
    list.sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1));
  }
  const offered = (node: PickerNode, hiddenAbove: boolean): boolean =>
    (node.status === 'active' && (!hiddenAbove || includeHidden)) ||
    (node.status === 'hidden' && includeHidden);
  const out: PickerChoice[] = [];
  const choice = (node: PickerNode, path: readonly string[], general: boolean): PickerChoice => ({
    id: node.id,
    level: levelOf(byId, node.id),
    name: nameOf(node, locale),
    path,
    general,
    status: node.status === 'hidden' ? 'hidden' : 'active',
  });
  const walk = (parentId: string | null, path: readonly string[], hiddenAbove: boolean): void => {
    for (const node of children.get(parentId) ?? []) {
      // Merged and archived nodes end the walk: nothing under them is offered.
      if (node.status !== 'active' && node.status !== 'hidden') continue;
      const here = [...path, nameOf(node, locale)];
      const below = hiddenAbove || node.status === 'hidden';
      const level = levelOf(byId, node.id);
      if (level < LOWEST_PRODUCT_CATEGORY_LEVEL) {
        walk(node.id, here, below);
        continue;
      }
      const start = out.length;
      if (level < maxLevel) walk(node.id, here, below);
      const hasChildren = out.length > start;
      if (offered(node, hiddenAbove)) out.push(choice(node, here, hasChildren));
    }
  };
  walk(null, [], false);
  return out;
}
