import type { Id } from '@mondapac/shared-kernel';
import type { NamedCategory } from './scope-counts';

/** The most characters of `search_text` (the table's CHECK is 2000). */
export const MAX_SEARCH_TEXT_CHARS = 2000;
/** What the store and category names may take of it; the attribute words get the rest. */
export const MAX_NAME_WORDS_CHARS = 700;
/** A public store name is at most this long in the index. */
export const MAX_STORE_NAME_CHARS = 200;

/**
 * The names of these categories and of every category above them in the live tree, each once, in
 * the order met (the product's own categories first, then their parents), joined by a space. A
 * category the tree does not hold has no name. Pure.
 */
export function categoryNamesOf(
  categoryIds: readonly Id<'Category'>[],
  tree: readonly NamedCategory[],
): string {
  const byId = new Map(tree.map((node) => [node.id, node]));
  const names: string[] = [];
  const seen = new Set<Id<'Category'>>();
  for (const categoryId of categoryIds) {
    let current = byId.get(categoryId);
    while (current !== undefined && !seen.has(current.id)) {
      seen.add(current.id);
      names.push(current.name);
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
  }
  return names.join(' ');
}

const clipChars = (value: string, max: number): string => [...value].slice(0, max).join('').trim();

/**
 * The `search_text` of a document (weight C, below the product name and short text): the store's
 * public name and the category names first, then the attribute words, in 2000 characters. Null when
 * empty. Pure.
 */
export function composeSearchText(
  attributeText: string,
  storeName: string | null,
  categoryNames: string,
): string | null {
  const names = clipChars(
    [storeName === null ? '' : clipChars(storeName, MAX_STORE_NAME_CHARS), categoryNames]
      .filter((part) => part !== '')
      .join(' '),
    MAX_NAME_WORDS_CHARS,
  );
  const room = MAX_SEARCH_TEXT_CHARS - [...names].length - 1;
  const rest = clipChars(attributeText, Math.max(room, 0));
  const text = [names, rest].filter((part) => part !== '').join(' ');
  return text === '' ? null : text;
}
