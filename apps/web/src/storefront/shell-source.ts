import 'server-only';
import type { ApiRead } from './api.ts';
import { readOnce, topCategories, treeOf } from './category-tree.ts';
import { sampleFallback } from './home-source.ts';
import { navigationOf } from './navigation.ts';
import { SAMPLE_CONTENT } from './sample-home.ts';
import type { StorefrontContent } from './types.ts';

// The shell's menu (Browse drawer, search panel, 404 pages) from the approved navigation
// (`GET storefront/navigation`) and the live category tree (`GET catalog/categories`). The
// delivery area and the sellers are not read here; they stay the sample's. A failed or malformed
// read never breaks a page: the shell falls back as below and logs one line.
//
// Categories: the navigation's list when an admin has approved one; else the live tree's top
// level (sample categories beside a real tree would link to pages that do not exist); else, with
// the tree empty or unread, the sample while the sample fallback is on, otherwise none. Popular
// searches: the navigation's popular entries (their names), else the sample while the fallback
// is on. A search word is just text, so the sample ones are harmless next to real data.

export interface ShellReads {
  readonly tree: ApiRead<unknown>;
  readonly navigation: ApiRead<unknown>;
}

/** The shell content from the API's answers (see the rules above). */
export function shellFrom(
  reads: ShellReads,
  fallback: boolean,
  sample: StorefrontContent = SAMPLE_CONTENT,
): StorefrontContent {
  const rows = reads.tree.kind === 'ok' ? treeOf(reads.tree.body) : null;
  // Entries name categories by id, so they can only be read together with the tree.
  const nav =
    rows !== null && reads.navigation.kind === 'ok'
      ? navigationOf(reads.navigation.body, rows)
      : null;
  const top = rows === null ? [] : topCategories(rows);
  const categories =
    nav !== null && nav.categories.length > 0
      ? nav.categories
      : top.length > 0
        ? top
        : fallback
          ? sample.categories
          : [];
  const popularSearches =
    nav !== null && nav.popular.length > 0 ? nav.popular : fallback ? sample.popularSearches : [];
  return { ...sample, categories, popularSearches };
}

/** A read of one public route, as `apiGet` answers it. */
export type ShellReader = (path: string) => Promise<ApiRead<unknown>>;

const log = (line: Readonly<Record<string, unknown>>): void => {
  console.log(JSON.stringify(line));
};

/** The shell's content: from the API when API_BASE_URL is set, else the sample. */
export async function loadShellContent(
  read: ShellReader = readOnce,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<StorefrontContent> {
  const [tree, navigation] = await Promise.all([
    read('catalog/categories'),
    read('storefront/navigation'),
  ]);
  if (tree.kind === 'off' && navigation.kind === 'off') return SAMPLE_CONTENT;
  const content = shellFrom({ tree, navigation }, sampleFallback(env));
  // `apiGet` logs a refused or unreachable read; this line says the shell fell back.
  const rows = tree.kind === 'ok' ? treeOf(tree.body) : null;
  if (rows === null) log({ msg: 'storefront.shell-categories-unusable' });
  else if (navigation.kind !== 'ok' || navigationOf(navigation.body, rows) === null)
    log({ msg: 'storefront.shell-navigation-unusable' });
  return content;
}
