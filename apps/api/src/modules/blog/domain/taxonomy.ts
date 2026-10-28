import { at, closedObject, isRecord, plainText, problem } from './fields';
import type { Problems } from './fields';

// Categories (a name per Market locale) and tags (one name) of a Market. The slug of a category
// never changes, so a category's URL is stable; a tag's slug is made once from its name.

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/u;
const LOCALE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/u;

export const CATEGORY_NAME_MAX = 60;
export const TAG_NAME_MAX = 40;
export const MAX_CATEGORIES = 200;
export const MAX_TAGS = 2000;

function slugOf(problems: Problems, path: string, value: unknown, min: number, max: number) {
  if (typeof value !== 'string') {
    problem(problems, path, value === undefined ? 'required' : 'type');
    return null;
  }
  const slug = value.trim();
  if (slug.length < min || slug.length > max) {
    problem(problems, path, 'length');
    return null;
  }
  if (!SLUG.test(slug)) {
    problem(problems, path, 'format');
    return null;
  }
  return slug;
}

export interface CategoryInput {
  readonly slug: string;
  readonly names: ReadonlyMap<string, string>;
  readonly position: number;
}

/**
 * `names` must hold the Market's default locale and may hold only supported locales (Market
 * config), so a category is never nameless in the language buyers read.
 */
export function parseCategory(
  input: unknown,
  markets: { readonly defaultLocale: string; readonly supportedLocales: readonly string[] },
  options: { readonly slug: 'required' | 'forbidden' },
): { readonly category: CategoryInput | null; readonly problems: Problems } {
  const problems: Problems = [];
  if (
    !closedObject(
      problems,
      '',
      input,
      options.slug === 'required' ? ['slug', 'names', 'position'] : ['names', 'position'],
    )
  ) {
    return { category: null, problems };
  }
  const slug = options.slug === 'required' ? slugOf(problems, 'slug', input.slug, 2, 60) : '';
  const names = new Map<string, string>();
  if (!isRecord(input.names)) {
    problem(problems, 'names', input.names === undefined ? 'required' : 'type');
  } else {
    for (const [locale, value] of Object.entries(input.names)) {
      const path = at('names', locale.slice(0, 35));
      if (!LOCALE.test(locale) || !markets.supportedLocales.includes(locale)) {
        problem(problems, path, 'locale');
        continue;
      }
      const name = plainText(problems, path, value, { max: CATEGORY_NAME_MAX });
      if (name !== null) names.set(locale, name);
    }
    if (!names.has(markets.defaultLocale) && !problems.some((p) => p.path.startsWith('names'))) {
      problem(problems, at('names', markets.defaultLocale), 'required');
    }
  }
  let position = 0;
  if (input.position !== undefined) {
    if (
      !Number.isInteger(input.position) ||
      (input.position as number) < 0 ||
      (input.position as number) > 10000
    ) {
      problem(problems, 'position', 'value');
    } else position = input.position as number;
  }
  if (problems.length > 0 || slug === null) return { category: null, problems };
  return { category: { slug, names, position }, problems };
}

export interface TagInput {
  readonly name: string;
  readonly slug: string;
}

export function parseTag(input: unknown): {
  readonly tag: TagInput | null;
  readonly problems: Problems;
} {
  const problems: Problems = [];
  if (!closedObject(problems, '', input, ['name', 'slug'])) return { tag: null, problems };
  const name = plainText(problems, 'name', input.name, { max: TAG_NAME_MAX });
  let slug: string | null = null;
  if (input.slug !== undefined) slug = slugOf(problems, 'slug', input.slug, 2, 40);
  else if (name !== null) {
    slug = name
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-+|-+$/gu, '')
      .slice(0, 40)
      .replace(/-+$/u, '');
    if (slug.length < 2) problem(problems, 'slug', 'required');
  }
  if (problems.length > 0 || name === null || slug === null) return { tag: null, problems };
  return { tag: { name, slug }, problems };
}
