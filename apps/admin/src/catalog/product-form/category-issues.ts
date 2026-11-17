// What a refused submit says about a product's categories (categories C5a codes).

/** What a refused submit says about the categories: the whole list, and one place in it. */
export interface CategoryIssues {
  readonly list?: string;
  readonly items: Readonly<Record<number, string>>;
}

const LIST_CODES = new Set(['required', 'too-many']);
const ITEM_CODES = new Set([
  'duplicate',
  'unknown',
  'category.not-available',
  'category.level-not-allowed',
]);

/** The issues at `categoryIds` and `categoryIds.<n>`, as a message key suffix per place. */
export function categoryIssuesOf(
  issues: readonly { readonly path: string; readonly code: string }[],
): CategoryIssues {
  let list: string | undefined;
  const items: Record<number, string> = {};
  for (const { path, code } of issues) {
    const at = /^categoryIds(?:\.(\d{1,3}))?$/.exec(path);
    if (at === null) continue;
    if (at[1] === undefined) {
      if (LIST_CODES.has(code)) list = code;
    } else if (ITEM_CODES.has(code)) {
      items[Number(at[1])] = code.replace(/^category\./, '');
    }
  }
  return { ...(list === undefined ? {} : { list }), items };
}

/** Whether an issue is one the category field tells (so it is not also listed as a raw line). */
export function isCategoryIssue(issue: { readonly path: string; readonly code: string }): boolean {
  return (
    categoryIssuesOf([issue]).list !== undefined ||
    Object.keys(categoryIssuesOf([issue]).items).length > 0
  );
}
