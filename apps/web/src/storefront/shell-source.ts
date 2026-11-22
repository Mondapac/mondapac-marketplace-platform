import 'server-only';
import type { ApiRead } from './api.ts';
import { readOnce, topCategories, treeOf } from './category-tree.ts';
import { navigationOf } from './navigation.ts';
import { SAMPLE_CONTENT } from './sample-home.ts';
import type { StorefrontContent } from './types.ts';

// The shell's menu (Browse drawer, search panel, 404 pages) from the approved navigation
// (`GET storefront/navigation`) and the live category tree (`GET catalog/categories`). The
// delivery area is not read here (it stays the sample's label until the deliver-to PR); the shell
// carries no sellers and no home sections. A failed or malformed read never breaks a page: the
// shell shows less, as below, and logs one line. With the API on no sample content is shown.
//
// Categories: the navigation's list when an admin has approved one; else the live tree's top
// level; else none. Popular searches: the navigation's popular entries (their names), else none.

export interface ShellReads {
  readonly tree: ApiRead<unknown>;
  readonly navigation: ApiRead<unknown>;
}

/** The shell content from the API's answers (see the rules above). */
export function shellFrom(
  reads: ShellReads,
  sample: StorefrontContent = SAMPLE_CONTENT,
): StorefrontContent {
  const rows = reads.tree.kind === 'ok' ? treeOf(reads.tree.body) : null;
  // Entries name categories by id, so they can only be read together with the tree.
  const nav =
    rows !== null && reads.navigation.kind === 'ok'
      ? navigationOf(reads.navigation.body, rows)
      : null;
  const top = rows === null ? [] : topCategories(rows);
  const categories = nav !== null && nav.categories.length > 0 ? nav.categories : top;
  const popularSearches = nav !== null && nav.popular.length > 0 ? nav.popular : [];
  // Only the delivery area is the sample's; no sample sellers or home sections leak.
  return { delivery: sample.delivery, popularSearches, categories, sellers: [], home: [] };
}

/** A read of one public route, as `apiGet` answers it. */
export type ShellReader = (path: string) => Promise<ApiRead<unknown>>;

const log = (line: Readonly<Record<string, unknown>>): void => {
  console.log(JSON.stringify(line));
};

/** The shell's content: from the API when API_BASE_URL is set, else the sample. */
export async function loadShellContent(read: ShellReader = readOnce): Promise<StorefrontContent> {
  const [tree, navigation] = await Promise.all([
    read('catalog/categories'),
    read('storefront/navigation'),
  ]);
  if (tree.kind === 'off' && navigation.kind === 'off') return SAMPLE_CONTENT;
  const content = shellFrom({ tree, navigation });
  // `apiGet` logs a refused or unreachable read; this line says the shell fell back.
  const rows = tree.kind === 'ok' ? treeOf(tree.body) : null;
  if (rows === null) log({ msg: 'storefront.shell-categories-unusable' });
  else if (navigation.kind !== 'ok' || navigationOf(navigation.body, rows) === null)
    log({ msg: 'storefront.shell-navigation-unusable' });
  return content;
}
