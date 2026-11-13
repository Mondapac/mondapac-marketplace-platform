import type { ApiFailure } from '../../api/client.ts';
import { indexOf, nameIn } from '../tree-model.ts';
import type { CategoryRow } from '../types.ts';
import type { ShelfText } from './types.ts';

/** The path of a category in the default language: "Pantry › Rice". Empty for an unknown id. */
export function pathText(
  rows: readonly CategoryRow[],
  id: string,
  locale: string,
  separator = ' › ',
): string {
  const { byId } = indexOf(rows);
  const names: string[] = [];
  let current = byId.get(id);
  let guard = 0;
  while (current !== undefined && guard++ < 10) {
    names.unshift(nameIn(current.names, locale) ?? current.slug);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return names.join(separator);
}

/** The platform categories a shelf may be merged into: the live ones, with their path. */
export function mergeTargets(
  rows: readonly CategoryRow[],
  locale: string,
): { readonly value: string; readonly label: string }[] {
  return rows
    .filter((row) => row.status === 'active')
    .map((row) => ({ value: row.id, label: pathText(rows, row.id, locale) }));
}

/** An English URL name from the shelf's English name; empty when the name has no Latin letters. */
export function suggestSlug(texts: readonly ShelfText[]): string {
  const english = texts.find((text) => text.locale.split('-')[0] === 'en') ?? texts[0];
  const base = (english?.name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
  return base;
}

export const SLUG_SHAPE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The shelf or proposal name to show for a heading, in the default language first. */
export function headline(texts: readonly ShelfText[], locale: string): string {
  return (
    texts.find((text) => text.locale === locale)?.name ??
    [...texts].sort((a, b) => (a.locale < b.locale ? -1 : 1))[0]?.name ??
    ''
  );
}

export interface ProposalProblem {
  /** A key under `categories.proposals.error`. */
  readonly key: string;
  /** The page read old data: read the queue again. */
  readonly reload: boolean;
  readonly max?: number;
}

const KNOWN = new Set([
  'validation.failed',
  'category-proposal.not-allowed',
  'category-proposal.not-found',
  'category-proposal.not-pending',
  'category-proposal.duplicate',
  'seller-category.not-found',
  'seller-category.not-active',
  'category.parent-not-found',
  'category.not-found',
  'category.slug-taken',
  'category.sibling-name-taken',
  'category.depth-exceeded',
  'category.required-locale-missing',
  'category.claim-word',
  'category.locale-uncheckable',
  'claim-text.check-unavailable',
  'conflict.stale',
  'access.denied',
  'access.permission-missing',
  'access.acting-as-refused',
  'access.unavailable',
  'request.csrf',
]);

const RELOAD = new Set([
  'category-proposal.not-found',
  'category-proposal.not-pending',
  'seller-category.not-found',
  'seller-category.not-active',
  'category.parent-not-found',
  'category.not-found',
  'conflict.stale',
]);

/** What a refused decision, promote or merge says. An unknown code gets the generic words. */
export function problemOf(failure: ApiFailure): ProposalProblem {
  const code = KNOWN.has(failure.code)
    ? failure.code
    : failure.status === 0 || failure.status >= 500
      ? 'access.unavailable'
      : 'unknown';
  return {
    key: code.replace(/\./g, '_'),
    reload: RELOAD.has(code),
    ...(failure.details?.max === undefined ? {} : { max: failure.details.max }),
  };
}
